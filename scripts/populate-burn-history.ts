/**
 * Script to populate historical data with burn history
 *
 * This script processes deltaBurn data (daily burn amounts) and converts them
 * to cumulative burn totals, then creates historical records for each day.
 */

import { logger } from "../lib/logger";

interface BurnDataPoint {
  date: string; // YYYY-MM-DD format
  deltaBurn: number; // Daily burn amount
}

interface HistoricalRecord {
  timestamp: string;
  burnedSupply: number;
  mintedSupply: number;
  totalSupply: number;
  circulatingSupply: number;
  restrictedSupply?: number;
  communitySupply?: number;
  inflationRate: number;
  stakingApr?: number;
  stakingRate?: number;
}

/**
 * Parse CSV file containing burn history
 */
async function parseBurnHistoryCSV(filePath: string): Promise<BurnDataPoint[]> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");

  const lines = content.trim().split("\n");
  const data: BurnDataPoint[] = [];

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const [date, deltaBurnStr] = line.split(",");
    const deltaBurn = parseFloat(deltaBurnStr);

    if (date && !isNaN(deltaBurn)) {
      data.push({ date, deltaBurn });
    }
  }

  return data;
}

// Current known values (as of 2024-11-13)
const CURRENT_BURNED = 8025422.446128;
const CURRENT_TOTAL_SUPPLY = 743424291.445315;
const CURRENT_CIRCULATING = 493486807.9686545;
const CURRENT_INFLATION_RATE = 1.951782853268271;

/**
 * Calculate cumulative burn from delta burn history
 */
function calculateCumulativeBurn(data: BurnDataPoint[]): Map<string, number> {
  const cumulative = new Map<string, number>();
  let total = 0;

  for (const point of data) {
    total += point.deltaBurn;
    cumulative.set(point.date, total);
  }

  return cumulative;
}

/**
 * Estimate historical values based on current values and burn history
 * This is a simplified estimation - ideally we'd fetch actual historical data
 */
function estimateHistoricalMetrics(
  date: string,
  cumulativeBurn: number,
  currentBurned: number,
  currentTotalSupply: number,
  currentCirculating: number,
  currentInflationRate: number
): Omit<HistoricalRecord, "timestamp"> {
  // Calculate how much less was burned at this historical point
  const burnDifference = currentBurned - cumulativeBurn;

  // Estimate minted supply (total supply + burned)
  const currentMintedSupply = currentTotalSupply + currentBurned;
  const estimatedMintedSupply = currentMintedSupply - burnDifference;

  // Estimate total supply (minted - burned)
  const estimatedTotalSupply = estimatedMintedSupply - cumulativeBurn;

  // Estimate circulating supply (proportional adjustment)
  const circulatingRatio = currentCirculating / currentTotalSupply;
  const estimatedCirculating = estimatedTotalSupply * circulatingRatio;

  // Inflation rate has been relatively stable - use current rate
  // In reality, this would need actual historical data
  const estimatedInflationRate = currentInflationRate;

  return {
    burnedSupply: cumulativeBurn,
    mintedSupply: estimatedMintedSupply,
    totalSupply: estimatedTotalSupply,
    circulatingSupply: estimatedCirculating,
    inflationRate: estimatedInflationRate,
  };
}

/**
 * Generate historical records from burn history
 */
function generateHistoricalRecords(
  burnHistory: BurnDataPoint[]
): HistoricalRecord[] {
  const cumulativeBurns = calculateCumulativeBurn(burnHistory);
  const records: HistoricalRecord[] = [];

  for (const [date, cumulativeBurn] of cumulativeBurns) {
    const metrics = estimateHistoricalMetrics(
      date,
      cumulativeBurn,
      CURRENT_BURNED,
      CURRENT_TOTAL_SUPPLY,
      CURRENT_CIRCULATING,
      CURRENT_INFLATION_RATE
    );

    // Create timestamp at 17:20 UTC for consistency
    const timestamp = new Date(`${date}T17:20:00.000Z`).toISOString();

    records.push({
      timestamp,
      ...metrics,
    });
  }

  return records;
}

/**
 * Main execution
 */
async function main() {
  const fs = await import("fs/promises");
  const path = await import("path");

  // Read burn history from CSV
  const csvPath = path.join(process.cwd(), "data", "burn-history.csv");
  logger.info(`Reading burn history from ${csvPath}...`);

  const burnHistory = await parseBurnHistoryCSV(csvPath);
  logger.info(`Loaded ${burnHistory.length} burn data points`);

  // Generate historical records
  logger.info("Generating historical records from burn data...");
  const records = generateHistoricalRecords(burnHistory);

  logger.info(`Generated ${records.length} historical records`);
  logger.info(
    `Date range: ${records[0]?.timestamp} to ${records[records.length - 1]?.timestamp}`
  );

  // Write to history.json
  const historyPath = path.join(process.cwd(), "data", "history.json");
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, JSON.stringify(records, null, 2));

  logger.info(`✓ Historical data written to ${historyPath}`);
  logger.info(`\nSample records:`);
  logger.info(
    `First: ${records[0]?.timestamp} - Burned: ${records[0]?.burnedSupply.toLocaleString()}`
  );
  logger.info(
    `Last: ${records[records.length - 1]?.timestamp} - Burned: ${records[records.length - 1]?.burnedSupply.toLocaleString()}`
  );
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => logger.error("Error in main:", error));
}

export { generateHistoricalRecords, calculateCumulativeBurn };
