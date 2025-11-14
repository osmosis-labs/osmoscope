import fs from "fs/promises";
import path from "path";
import { logger } from "../lib/logger";

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const REVENUE_API_URL =
  "https://www.datalenses.zone/numia/osmosis/lensesV2/business/revenue_share_by_source";

interface HistoricalRecord {
  timestamp: string;
  burnedSupply: number;
  mintedSupply: number;
  totalSupply: number;
  circulatingSupply: number;
  inflationRate: number;
  stakingApr?: number;
  stakingRate?: number;
  // Protocol revenue fields (daily values in USD)
  txnFeesRevenue?: number;
  takerFeesRevenue?: number;
  protorevRevenue?: number;
  mevRevenue?: number;
  totalRevenue?: number;
  [key: string]: unknown;
}

interface RevenueEntry {
  labels: string; // ISO 8601 date
  mev: number;
  protorev: number;
  txn_fees: number;
  taker_fees: number;
  total: number;
}

async function fetchRevenueData(): Promise<RevenueEntry[]> {
  // Fetch data from 2021 to current date
  const endDate = new Date().toISOString().split("T")[0];
  const url = `${REVENUE_API_URL}?sources=txn_fees,protorev,taker_fees,mev,total&start_date=2021-01-13&end_date=${endDate}`;

  logger.info(`Fetching revenue data from ${url}...`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch revenue data: ${response.statusText}`);
  }

  const data: RevenueEntry[] = await response.json();

  logger.info(`Fetched ${data.length} revenue data points`);

  return data;
}

async function populateRevenueHistory() {
  logger.info("Loading history file...");

  // Read existing history
  const content = await fs.readFile(HISTORY_FILE, "utf-8");
  const history: HistoricalRecord[] = JSON.parse(content);

  logger.info(`Found ${history.length} historical records`);

  if (history.length === 0) {
    logger.info("No historical data to populate");
    return;
  }

  // Fetch revenue data
  const revenueData = await fetchRevenueData();

  // Create a map of date -> revenue for quick lookup
  const revenueMap = new Map<string, RevenueEntry>();
  revenueData.forEach((entry) => {
    const date = entry.labels.split("T")[0]; // Extract date part (YYYY-MM-DD)
    revenueMap.set(date, entry);
  });

  logger.info(`Created revenue map with ${revenueMap.size} dates`);

  // Populate revenue data for each historical record
  let updatedCount = 0;

  for (const record of history) {
    const recordDate = new Date(record.timestamp);
    const recordDateStr = recordDate.toISOString().split("T")[0];

    // Find revenue data for this date
    const revenue = revenueMap.get(recordDateStr);
    if (revenue) {
      record.txnFeesRevenue = revenue.txn_fees;
      record.takerFeesRevenue = revenue.taker_fees;
      record.protorevRevenue = revenue.protorev;
      record.mevRevenue = revenue.mev;
      record.totalRevenue = revenue.total;
      updatedCount++;
    }
  }

  logger.info(`Updated ${updatedCount} records with revenue data`);

  // Save updated history
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));

  logger.info("Successfully populated revenue history!");

  // Calculate and log recent averages
  const recentRecords = history.slice(-30).filter((r) => r.totalRevenue);
  if (recentRecords.length > 0) {
    const avgTxnFees =
      recentRecords.reduce((sum, r) => sum + (r.txnFeesRevenue || 0), 0) /
      recentRecords.length;
    const avgTakerFees =
      recentRecords.reduce((sum, r) => sum + (r.takerFeesRevenue || 0), 0) /
      recentRecords.length;
    const avgProtorev =
      recentRecords.reduce((sum, r) => sum + (r.protorevRevenue || 0), 0) /
      recentRecords.length;
    const avgMev =
      recentRecords.reduce((sum, r) => sum + (r.mevRevenue || 0), 0) /
      recentRecords.length;
    const avgTotal =
      recentRecords.reduce((sum, r) => sum + (r.totalRevenue || 0), 0) /
      recentRecords.length;

    logger.info("\n30-day average daily revenue (USD):");
    logger.info(`  Transaction Fees: $${avgTxnFees.toFixed(2)}`);
    logger.info(`  Taker Fees: $${avgTakerFees.toFixed(2)}`);
    logger.info(`  ProtoRev: $${avgProtorev.toFixed(2)}`);
    logger.info(`  MEV (Top of Block): $${avgMev.toFixed(2)}`);
    logger.info(`  Total: $${avgTotal.toFixed(2)}`);
  }
}

// Run the script
populateRevenueHistory().catch((error) => {
  logger.error("Error populating revenue history:", error);
  process.exit(1);
});
