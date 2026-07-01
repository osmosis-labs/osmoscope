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
import { saveTreasurySnapshot } from "../lib/treasury/store";
import { isDatabaseEnabled, prisma } from "../lib/database";

const DRY_RUN = process.argv.includes("--dry");

async function main() {
  console.log(
    "Building treasury snapshot (this fans out to many chain calls)…"
  );
  const snapshot = await buildTreasurySnapshot();

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
