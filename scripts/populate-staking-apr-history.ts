import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { logger } from "../lib/logger";

// Load environment variables
dotenv.config({ path: ".env.local" });

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const NUMIA_API_URL =
  process.env.NUMIA_API_URL || "https://public-osmosis-api.numia.xyz";
const NUMIA_API_KEY = process.env.NUMIA_API_KEY;

interface HistoricalRecord {
  timestamp: string;
  burnedSupply: number;
  mintedSupply: number;
  totalSupply: number;
  circulatingSupply: number;
  inflationRate: number;
  stakingApr?: number;
  [key: string]: unknown;
}

interface NumiaAprEntry {
  symbol: string;
  labels: string;
  apr: number;
}

async function fetchNumiaAprForDateRange(
  startDate: string,
  endDate: string
): Promise<NumiaAprEntry[]> {
  const url = `${NUMIA_API_URL}/apr?start_date=${startDate}&end_date=${endDate}`;

  logger.info(`Fetching APR data from ${startDate} to ${endDate}...`);

  const headers: HeadersInit = {
    Accept: "application/json",
  };

  // Add Authorization header if API key is configured
  if (NUMIA_API_KEY) {
    headers.Authorization = `Bearer ${NUMIA_API_KEY}`;
  }

  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch APR data: ${response.statusText}`);
  }

  const data: NumiaAprEntry[] = await response.json();

  // Filter for OSMO entries only
  const osmoEntries = data.filter(
    (entry) => entry.symbol === "OSMO" || entry.symbol === "total"
  );

  // Remove duplicates by date (keep one entry per day)
  const uniqueEntries = new Map<string, NumiaAprEntry>();
  osmoEntries.forEach((entry) => {
    const date = entry.labels.split(" ")[0]; // Extract date part (YYYY-MM-DD)
    if (!uniqueEntries.has(date)) {
      uniqueEntries.set(date, entry);
    }
  });

  return Array.from(uniqueEntries.values());
}

async function populateStakingAprHistory() {
  logger.info("Loading history file...");

  // Read existing history
  const content = await fs.readFile(HISTORY_FILE, "utf-8");
  const history: HistoricalRecord[] = JSON.parse(content);

  logger.info(`Found ${history.length} historical records`);

  if (history.length === 0) {
    logger.info("No historical data to populate");
    return;
  }

  // Get date range from history
  const oldestDate = new Date(history[0].timestamp);
  const newestDate = new Date(history[history.length - 1].timestamp);

  logger.info(
    `Date range: ${oldestDate.toISOString().split("T")[0]} to ${newestDate.toISOString().split("T")[0]}`
  );

  // Fetch APR data for 2+ years
  const fetchStartDate = new Date(newestDate);
  fetchStartDate.setDate(fetchStartDate.getDate() - 730);

  const startDateStr = fetchStartDate.toISOString().split("T")[0];
  const endDateStr = newestDate.toISOString().split("T")[0];

  const aprData = await fetchNumiaAprForDateRange(startDateStr, endDateStr);

  logger.info(`Fetched ${aprData.length} APR data points`);

  // Create a map of date -> APR for quick lookup
  const aprMap = new Map<string, number>();
  aprData.forEach((entry) => {
    const date = entry.labels.split(" ")[0];
    aprMap.set(date, entry.apr);
  });

  // Populate stakingApr for each historical record
  let updatedCount = 0;

  for (let i = 0; i < history.length; i++) {
    const record = history[i];
    const recordDate = new Date(record.timestamp);
    const recordDateStr = recordDate.toISOString().split("T")[0];

    // Set stakingApr (raw APR for this date)
    const rawApr = aprMap.get(recordDateStr);
    if (rawApr !== undefined) {
      record.stakingApr = rawApr;
      updatedCount++;
    }
  }

  logger.info(`Updated ${updatedCount} records with staking APR data`);

  // Save updated history
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));

  logger.info("Successfully populated staking APR history!");
}

// Run the script
populateStakingAprHistory().catch((error) => {
  logger.error("Error populating staking APR history:", error);
  process.exit(1);
});
