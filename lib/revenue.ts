// Protocol-revenue fetcher (Data Lenses / Numia). Shared by the hourly cron
// (lib/snapshot.ts, to keep recent rows fresh) and the manual backfill script
// (scripts/populate-revenue-history.ts). Server-only.
//
// IMPORTANT: this is PROTOCOL revenue only (taker fees, ProtoRev, tx fees,
// top-of-block/MEV). Data Lenses also exposes LP/swap-fee revenue elsewhere,
// which accrues to liquidity providers, NOT the protocol — the dashboard's
// revenue chart and headline intentionally exclude it, so we only pull these
// four sources plus the matching `total`.
import { logger } from "./logger";

const REVENUE_API_URL =
  "https://www.datalenses.zone/numia/osmosis/lensesV2/business/revenue_share_by_source";

// One day's protocol revenue by source (USD). `date` is YYYY-MM-DD (UTC).
export interface DailyRevenue {
  date: string;
  txnFeesRevenue: number;
  takerFeesRevenue: number;
  protorevRevenue: number;
  mevRevenue: number;
  totalRevenue: number;
}

// Raw Data Lenses row shape.
interface RevenueEntry {
  labels: string; // ISO 8601 date
  mev: number;
  protorev: number;
  txn_fees: number;
  taker_fees: number;
  total: number;
}

// Fetch daily protocol revenue from Data Lenses for [startDate, endDate] (both
// YYYY-MM-DD, UTC). Returns one DailyRevenue per day the source has data for.
// NOTE: Data Lenses lags the live chain by several days — the latest returned
// date is typically ~today-5, not today. Callers must treat missing recent days
// as "not yet available upstream" (leave null), NOT as zero revenue.
export async function fetchDailyRevenue(
  startDate: string,
  endDate: string
): Promise<DailyRevenue[]> {
  const url = `${REVENUE_API_URL}?sources=txn_fees,protorev,taker_fees,mev,total&start_date=${startDate}&end_date=${endDate}`;
  logger.info(
    `Fetching protocol revenue from Data Lenses (${startDate} → ${endDate})`
  );

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Data Lenses revenue fetch failed: HTTP ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as RevenueEntry[];
  if (!Array.isArray(data)) {
    throw new Error("Data Lenses revenue response was not an array");
  }

  logger.info(`Fetched ${data.length} daily revenue rows`);
  return data.map((e) => ({
    date: e.labels.split("T")[0],
    txnFeesRevenue: e.txn_fees,
    takerFeesRevenue: e.taker_fees,
    protorevRevenue: e.protorev,
    mevRevenue: e.mev,
    totalRevenue: e.total,
  }));
}

// Build a date -> DailyRevenue lookup for O(1) matching against snapshot dates.
export function indexRevenueByDate(
  rows: DailyRevenue[]
): Map<string, DailyRevenue> {
  const map = new Map<string, DailyRevenue>();
  for (const r of rows) map.set(r.date, r);
  return map;
}
