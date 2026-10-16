#!/usr/bin/env tsx
// Re-sync every HistoricalRecord's staking APR with Numia's /apr series, keyed
// by date (row dated D gets Numia's APR for D; see lib/staking-apr.ts).
//
// Why: the live snapshot took the LAST element of Numia's newest-first array as
// "today", which is the oldest day of its 30-day window, so every row it wrote
// held the APR from 30 days earlier. This rewrites stakingApr on every row
// Numia covers (also filling archive rows Numia previously had no figure for),
// and recomputes stakingRate, the trailing 30-day average, on the rows that
// already carry one. Archive rows that never had a stakingRate keep it unset.
//
// The hourly refreshRecentStakingApr keeps the last month in sync from here on;
// this is for the full history. Idempotent: only differing values are written.
// Dry-run by default; set APPLY=1 to write. Requires a DB connection
// (POSTGRES_PRISMA_URL / DATABASE_URL).

import { prisma, isDatabaseEnabled } from "../lib/database";
import { fetchStakingAprByDate } from "../lib/osmosis-lcd";
import {
  backfillStakingAprInDatabase,
  type StakingAprUpdate,
} from "../lib/historical-file-db";
import {
  APR_WINDOW_DAYS,
  shiftDate,
  trailingAprAverage,
} from "../lib/staking-apr";

const APPLY = process.env.APPLY === "1";

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

  const rows = await prisma.historicalRecord.findMany({
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, stakingApr: true, stakingRate: true },
  });
  if (rows.length === 0) {
    console.log("No rows.");
    return;
  }
  const first = rows[0].timestamp.toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const byDate = await fetchStakingAprByDate(
    shiftDate(first, -APR_WINDOW_DAYS),
    today
  );
  console.log(`Numia returned ${byDate.size} day(s) of APR.`);
  if (byDate.size === 0) {
    console.error("❌ Numia returned no figures; nothing to sync against.");
    process.exit(1);
  }

  const updates = new Map<string, StakingAprUpdate>();
  let aprChanges = 0;
  let rateChanges = 0;
  let maxAprDelta = 0;
  let maxRateDelta = 0;
  for (const r of rows) {
    const day = r.timestamp.toISOString().split("T")[0];
    const stakingApr = byDate.get(day);
    const stakingRate =
      r.stakingRate != null ? trailingAprAverage(byDate, day) : undefined;
    if (stakingApr == null && stakingRate == null) continue;
    updates.set(day, { stakingApr, stakingRate });

    // Same equality as backfillStakingAprInDatabase (within the column's 6th
    // decimal).
    const differs = (stored: number, next: number) =>
      Math.abs(stored - next) >= 1e-6;
    if (
      stakingApr != null &&
      (r.stakingApr == null || differs(Number(r.stakingApr), stakingApr))
    ) {
      aprChanges++;
      if (r.stakingApr != null) {
        maxAprDelta = Math.max(
          maxAprDelta,
          Math.abs(Number(r.stakingApr) - stakingApr)
        );
      }
    }
    if (stakingRate != null && differs(Number(r.stakingRate), stakingRate)) {
      rateChanges++;
      maxRateDelta = Math.max(
        maxRateDelta,
        Math.abs(Number(r.stakingRate) - stakingRate)
      );
    }
  }

  console.log(
    `stakingApr: ${aprChanges} row(s) to change (largest change to an existing value ${maxAprDelta.toFixed(3)}pp)`
  );
  console.log(
    `stakingRate: ${rateChanges} row(s) to change (largest change ${maxRateDelta.toFixed(3)}pp)`
  );

  if (!APPLY) return;
  const n = await backfillStakingAprInDatabase(updates, {
    fillMissingRates: false,
  });
  console.log(`\n✓ Updated ${n} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
