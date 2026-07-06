#!/usr/bin/env tsx
// ONE-OFF correction: historical rows were written with the offset-applied
// supply/by_denom as mintedSupply AND had dev-vesting subtracted again via
// restrictedSupply, so dev-vesting was removed twice — understating minted,
// total, and circulating by that day's unvested dev-vesting balance (~55-63M).
//
// This fetches each row's dev-vesting module balance at that date's height
// (archive serves below-tip balances directly and reliably), then:
//   mintedSupply    += devVesting   (offset reversed → raw minted basis)
//   totalSupply     += devVesting   (= raw minted − burned)
//   circulatingSupply += devVesting (total rose; restricted already includes it)
//   devVestingSupply  = devVesting  (new field, so re-runs are idempotent)
// restrictedSupply is UNCHANGED (it already correctly includes dev-vesting once).
//
// Idempotent: rows that already have devVestingSupply set are skipped. Does NOT
// touch burn / staking / revenue / restricted. Dry-run by default; set APPLY=1
// to write. Requires a DB connection (POSTGRES_PRISMA_URL / DATABASE_URL).

import { prisma, isDatabaseEnabled } from "../lib/database";
import {
  getBlockHeightForDate,
  queryArchiveNodeWithFallback,
} from "./lib/archive-node";

const DEV_VESTING_ADDR = "osmo1vqy8rqqlydj9wkcyvct9zxl3hc4eqgu3d7hd9k";
const APPLY = process.env.APPLY === "1";

async function fetchDevVestingAt(date: string): Promise<number | null> {
  const height = await getBlockHeightForDate(date);
  const resp = await queryArchiveNodeWithFallback<{
    balance: { denom: string; amount: string };
  }>(
    `/cosmos/bank/v1beta1/balances/${DEV_VESTING_ADDR}/by_denom?denom=uosmo`,
    date,
    height
  );
  if (!resp?.balance?.amount) return null;
  return parseInt(resp.balance.amount) / 1_000_000;
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error(
      "❌ No database configured (POSTGRES_PRISMA_URL / DATABASE_URL)."
    );
    process.exit(1);
  }
  console.log(
    APPLY
      ? "APPLY mode — will write.\n"
      : "DRY-RUN — no writes (set APPLY=1 to write).\n"
  );

  // Only rows not yet corrected. circulatingSupply may be null (2023 window) —
  // still correct minted/total there; leave circulating null.
  const rows = await prisma.historicalRecord.findMany({
    where: { devVestingSupply: null },
    orderBy: { timestamp: "asc" },
    select: {
      timestamp: true,
      mintedSupply: true,
      totalSupply: true,
      circulatingSupply: true,
    },
  });
  console.log(`${rows.length} rows to correct.\n`);

  let corrected = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = r.timestamp.toISOString().split("T")[0];
    let dv: number | null = null;
    try {
      dv = await fetchDevVestingAt(date);
    } catch {
      dv = null;
    }
    if (dv == null || !(dv > 0)) {
      // Couldn't read a positive dev-vesting balance for this date — skip rather
      // than write a wrong (0) correction. Report so it can be handled.
      failed++;
      console.log(`  ${date}: dev-vesting UNREADABLE — skipped`);
      continue;
    }

    const minted = Number(r.mintedSupply) + dv;
    const total = Number(r.totalSupply) + dv;
    const circ =
      r.circulatingSupply == null ? null : Number(r.circulatingSupply) + dv;

    if (i < 3 || i % 200 === 0) {
      console.log(
        `  ${date}: +${dv.toFixed(0)} devVest → minted ${minted.toFixed(0)}, circ ${circ == null ? "null" : circ.toFixed(0)}`
      );
    }

    if (APPLY) {
      await prisma.historicalRecord.update({
        where: { timestamp: r.timestamp },
        data: {
          mintedSupply: minted,
          totalSupply: total,
          circulatingSupply: circ,
          devVestingSupply: dv,
        },
      });
    }
    corrected++;
  }

  console.log(
    `\nDone. Corrected: ${corrected}, unreadable/skipped: ${failed}. ${APPLY ? "WRITTEN." : "(dry-run — nothing written)"}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Correction failed:", e);
  process.exit(1);
});
