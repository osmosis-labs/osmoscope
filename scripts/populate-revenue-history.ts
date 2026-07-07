#!/usr/bin/env tsx
// Backfill / gap-fill protocol-revenue fields on historical rows in the DB.
//
// Fetches daily protocol revenue from Data Lenses and stamps the five revenue
// fields (txnFees/takerFees/protorev/mev/total) onto each HistoricalRecord whose
// calendar day the source has data for. Writes to Postgres via Prisma — the same
// store the deployed app and cron use. (The previous version wrote to a local
// data/history.json file that prod never reads, so it silently no-op'd against
// prod.)
//
// Idempotent: re-running only refreshes the revenue fields; it never touches
// supply/staking/burn. Dry-run by default; set APPLY=1 to write. Requires a DB
// connection (POSTGRES_PRISMA_URL / DATABASE_URL).
//
// The hourly cron (lib/snapshot.ts) now also fills recent rows as Data Lenses
// publishes them, so this script is mainly for the initial backfill or a manual
// catch-up.
import { prisma, isDatabaseEnabled } from "../lib/database";
import { fetchDailyRevenue, indexRevenueByDate } from "../lib/revenue";

const APPLY = process.env.APPLY === "1";
// Revenue capture begins 2022-04 on Data Lenses; start earlier is harmless (no
// rows returned). Kept as the historical script default.
const START_DATE = "2021-01-13";

function dayOf(ts: Date): string {
  return ts.toISOString().split("T")[0];
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

  const endDate = new Date().toISOString().split("T")[0];
  const revenue = indexRevenueByDate(
    await fetchDailyRevenue(START_DATE, endDate)
  );
  console.log(`Revenue available for ${revenue.size} dates (latest upstream).`);

  const rows = await prisma.historicalRecord.findMany({
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, totalRevenue: true },
  });
  console.log(`${rows.length} historical rows in DB.\n`);

  let updated = 0;
  let noData = 0;
  let unchanged = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = dayOf(r.timestamp);
    const rev = revenue.get(date);
    if (!rev) {
      // Data Lenses has no row for this date (either pre-capture, or the recent
      // lag window where upstream hasn't published yet). Leave it — the cron will
      // fill recent days as they become available.
      noData++;
      continue;
    }
    // Skip rows already carrying this exact total (idempotent no-op).
    if (r.totalRevenue != null && Number(r.totalRevenue) === rev.totalRevenue) {
      unchanged++;
      continue;
    }

    if (i < 3 || i % 200 === 0) {
      console.log(
        `  ${date}: total $${rev.totalRevenue.toFixed(0)} (taker ${rev.takerFeesRevenue.toFixed(0)}, protorev ${rev.protorevRevenue.toFixed(0)}, tx ${rev.txnFeesRevenue.toFixed(0)}, mev ${rev.mevRevenue.toFixed(0)})`
      );
    }

    if (APPLY) {
      await prisma.historicalRecord.update({
        where: { timestamp: r.timestamp },
        data: {
          txnFeesRevenue: rev.txnFeesRevenue,
          takerFeesRevenue: rev.takerFeesRevenue,
          protorevRevenue: rev.protorevRevenue,
          mevRevenue: rev.mevRevenue,
          totalRevenue: rev.totalRevenue,
        },
      });
    }
    updated++;
  }

  console.log(
    `\nDone. Updated: ${updated}, already-current: ${unchanged}, no-upstream-data: ${noData}. ${APPLY ? "WRITTEN." : "(dry-run — nothing written)"}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Revenue population failed:", e);
  process.exit(1);
});
