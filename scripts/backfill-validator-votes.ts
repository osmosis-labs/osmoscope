#!/usr/bin/env tsx
// One-time seed of the ValidatorVote table: for every bonded validator, fetch
// every proposal id its voting account has EVER voted on at FULL depth (the
// archive + deep + primary tx-index union in lib/governance.ts) and insert.
// The daily cron only needs the recent chain going forward.
//
// Paced for the archive's rate limiting (sequential, delay between validators,
// backoff on 429). Idempotent (insert-only with skipDuplicates); dry-run by
// default, APPLY=1 writes. Requires a DB connection.
import { prisma, isDatabaseEnabled } from "../lib/database";
import {
  fetchBondedValidators,
  accountAddressFromOperator,
} from "../lib/validators";
import { fetchVoterProposalIdsFullDepth } from "../lib/governance";
import { GOV_VOTER_OVERRIDES } from "../config/gov-voter-overrides";

const APPLY = process.env.APPLY === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry a fetch-backed call on failure (the archive 429s under load).
async function withRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // The >1000-tx page-cap throw is deterministic — retrying it just burns
      // half a minute of sleeps before failing identically.
      if (e instanceof Error && e.message.includes("refusing to truncate")) {
        throw new Error(`${label}: ${e.message}`);
      }
      lastErr = e;
      await sleep(3000 * (attempt + 1));
    }
  }
  throw new Error(
    `${label}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("❌ No database configured.");
    process.exit(1);
  }
  console.log(
    APPLY
      ? "APPLY mode — will write.\n"
      : "DRY-RUN — no writes (APPLY=1 to write).\n"
  );

  const validators = await fetchBondedValidators();
  console.log(`${validators.length} bonded validators.\n`);

  let totalRows = 0;
  let failures = 0;
  for (const v of validators) {
    const override = GOV_VOTER_OVERRIDES[v.operatorAddress];
    if (override === null) {
      console.log(`  ${v.moniker}: voter account unknown, skipped`);
      continue;
    }
    const account = override ?? accountAddressFromOperator(v.operatorAddress);
    if (!account) {
      console.log(`  ${v.moniker}: could not derive account, skipped`);
      continue;
    }
    try {
      const union = await withRetries(
        () => fetchVoterProposalIdsFullDepth(account),
        v.moniker
      );
      console.log(`  ${v.moniker}: ${union.size} proposals (full depth)`);
      totalRows += union.size;
      if (APPLY && union.size > 0) {
        await prisma.validatorVote.createMany({
          data: [...union].map((proposalId) => ({
            operatorAddress: v.operatorAddress,
            proposalId,
          })),
          skipDuplicates: true,
        });
      }
    } catch (e) {
      failures++;
      console.error(
        `  ❌ ${v.moniker}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    await sleep(1200); // pace the archive
  }

  console.log(
    `\nDone. ${APPLY ? "Inserted (deduped)" : "Would insert"}: up to ${totalRows} rows across ${validators.length} validators; failures: ${failures}.${APPLY ? " WRITTEN." : " (dry-run)"}`
  );
  if (failures > 0)
    console.log("Re-run for the failed validators — inserts are idempotent.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Vote backfill failed:", e);
  process.exit(1);
});
