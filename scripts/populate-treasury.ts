#!/usr/bin/env tsx
// Manual treasury-snapshot runner: builds the community-pool / DAO-treasury
// snapshot and stores it, exactly as the hourly cron does, without needing the
// cron to fire. Use it to seed the first snapshot after deploy or to refresh
// on demand.
//
//   npm run populate-treasury            # build + save to the database
//   npm run populate-treasury -- --dry   # build + print, do NOT save
import "dotenv/config";
import { buildTreasurySnapshot } from "../lib/treasury/snapshot";
import {
  saveTreasurySnapshot,
  getLatestTreasurySnapshot,
} from "../lib/treasury/store";
import { isDatabaseEnabled, prisma } from "../lib/database";

const DRY_RUN = process.argv.includes("--dry");
// `--force` skips the proportional move guard (for an intentional large change
// or the very first seed). Without it, the manual script applies the SAME guard
// the hourly cron uses, so a partial build can't be persisted by hand either.
const FORCE = process.argv.includes("--force");

async function main() {
  console.log(
    "Building treasury snapshot (this fans out to many chain calls)…"
  );
  // Pass the previous stored main-pool value so buildTreasurySnapshot's
  // proportional move guard runs here too (unless --dry, which never saves, or
  // --force). The cron does the same; without it the script could persist a
  // partial build that the cron would refuse.
  let previousMainPoolValue: number | null = null;
  if (!DRY_RUN && !FORCE && isDatabaseEnabled()) {
    try {
      const prev = await getLatestTreasurySnapshot();
      previousMainPoolValue = prev?.mainPool.totalValue ?? null;
    } catch {
      // no previous snapshot / DB not reachable — guard simply won't apply
    }
  }
  const snapshot = await buildTreasurySnapshot({ previousMainPoolValue });

  const fmt = (n: number) =>
    "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });

  console.log(`\nTotal treasury value: ${fmt(snapshot.totalValue)}`);
  console.log(
    `Main pool: ${fmt(snapshot.mainPool.totalValue)} (${snapshot.mainPool.holdings.length} line items)`
  );
  console.log(`\nHolders (${snapshot.holders.length}), by value:`);
  for (const h of snapshot.holders) {
    console.log(`  ${fmt(h.totalValue).padStart(14)}  ${h.label}`);
  }
  if (snapshot.unpricedSymbols.length > 0) {
    console.log(
      `\n⚠ Unpriced symbols (surfaced, valued at $0): ${snapshot.unpricedSymbols.join(", ")}`
    );
  }

  if (DRY_RUN) {
    console.log("\n--dry: not saving.");
    return;
  }
  if (!isDatabaseEnabled()) {
    console.error(
      "\n❌ Database not configured (POSTGRES_PRISMA_URL / DATABASE_URL). Use --dry to build without saving."
    );
    process.exit(1);
  }
  await saveTreasurySnapshot(snapshot);
  console.log("\n✓ Saved treasury snapshot to database.");
}

main()
  .catch((error) => {
    console.error("\n❌ Treasury snapshot failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
