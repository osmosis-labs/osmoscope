import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { type HistoricalRecord } from "../lib/historical-file";
import {
  validateInflationRate,
  exportEpochCacheToCSV,
} from "./lib/archive-node";
import {
  fetchMintedSupply,
  fetchBurnedSupply,
  fetchLockedBalances,
  fetchCommunityPool,
  fetchDistributionParams,
  fetchEpochProvisions,
  fetchChainInflation,
  fetchTotalStaked,
  type DistributionParams,
} from "./lib/archive-fetchers";

// ===================================
// Configuration & CLI Arguments
// ===================================

interface CliOptions {
  overwrite: boolean;
  startDate: string;
  endDate: string;
  parameter?: string;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    overwrite: false,
    startDate: "2022-02-01",
    endDate: new Date().toISOString().split("T")[0], // Default to today
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--start-date" && args[i + 1]) {
      options.startDate = args[++i];
    } else if (arg === "--end-date" && args[i + 1]) {
      options.endDate = args[++i];
    } else if (arg === "--parameter" && args[i + 1]) {
      options.parameter = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Osmosis Historical Data Population

Usage:
  yarn populate-from-archive [options]

Options:
  --overwrite           Overwrite all existing data (full repopulation)
  --start-date YYYY-MM-DD  Start date for population (default: 2022-02-01)
  --end-date YYYY-MM-DD    End date for population (default: today)
  --parameter PARAM     Only fetch missing/erroneous parameter (e.g., totalStaked)

Examples:
  # Fill missing dates only (default)
  yarn populate-from-archive

  # Full repopulation
  yarn populate-from-archive --overwrite

  # Populate specific date range
  yarn populate-from-archive --start-date 2023-01-01 --end-date 2023-12-31

  # Backfill missing totalStaked parameter
  yarn populate-from-archive --parameter totalStaked

  # Overwrite June 2024 data
  yarn populate-from-archive --overwrite --start-date 2024-06-01 --end-date 2024-06-30
      `);
      process.exit(0);
    }
  }

  return options;
}

const CLI_OPTIONS = parseCliArgs();
const CHECKPOINT_INTERVAL = 10; // Save progress every 10 days
const CHECKPOINT_FILE = path.join(
  process.cwd(),
  "data",
  "archive-progress.json"
);
const OUTPUT_FILE = path.join(process.cwd(), "data", "history-archive.json");

interface Checkpoint {
  lastProcessedDate: string;
  recordsGenerated: number;
  errors: Array<{ date: string; error: string }>;
  startTime: string;
}

// ===================================
// Checkpoint Management
// ===================================

function _loadCheckpoint(): Checkpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const content = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (error: unknown) {
    logger.warn("Failed to load checkpoint:", error);
  }
  return null;
}

function _saveCheckpoint(checkpoint: Checkpoint): void {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(CHECKPOINT_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
    logger.info(`✓ Checkpoint saved: ${checkpoint.recordsGenerated} records`);
  } catch (error: unknown) {
    logger.error("Failed to save checkpoint:", error);
  }
}

function _clearCheckpoint(): void {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
    }
  } catch (error: unknown) {
    logger.warn("Failed to clear checkpoint:", error);
  }
}

// ===================================
// Inflation Rate Calculator
// ===================================

// Annualized inflation rate (%), matching the chain's mint keeper GetInflation:
//
//   inflation = epochProvisions * (1 - communityPoolProportion) * 365 / supply
//
// epochProvisions are the daily (per-epoch) provisions, so the * 365 annualizes
// them. The (1 - communityPool) factor is the share of provisions that is NOT
// sent to the community pool (i.e. staking + developer + pool-incentives); the
// chain excludes the community-pool portion from the reported inflation. The
// denominator is the supply base.
//
// Previously this omitted the * 365 (producing a daily rate ~1/365 of the real
// value, e.g. 0.0054% instead of ~1.97%) and summed the three proportions
// explicitly, which drifted across the chain's distribution-proportion changes.
// Deriving (1 - communityPool) is robust to those param changes.
function calculateInflationRate(
  params: DistributionParams,
  epochProvisions: number,
  supply: number
): number {
  const communityPool = parseFloat(params.communityPool);
  const nonCommunityShare = 1 - communityPool;

  const annualizedProvisions = epochProvisions * nonCommunityShare * 365;
  const rate = (annualizedProvisions / supply) * 100; // percentage

  if (!validateInflationRate(rate)) {
    logger.warn(`Inflation rate out of expected range: ${rate}%`);
  }

  return rate;
}

// ===================================
// Date Range Planning
// ===================================

interface DateToProccess {
  date: string;
  reason: string;
}

function getDatesToProcess(): DateToProccess[] {
  const startDate = new Date(CLI_OPTIONS.startDate);
  const endDate = new Date(CLI_OPTIONS.endDate);
  const dates: DateToProccess[] = [];

  // Load existing data if not overwriting
  let existingData: HistoricalRecord[] = [];
  if (!CLI_OPTIONS.overwrite && fs.existsSync(OUTPUT_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
    } catch (_error: unknown) {
      logger.warn("Failed to load existing data, treating as empty");
    }
  }

  // Build map of existing dates
  const existingMap = new Map<string, HistoricalRecord>();
  for (const record of existingData) {
    const date = record.timestamp.split("T")[0];
    existingMap.set(date, record);
  }

  // Iterate through date range
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split("T")[0];
    const existing = existingMap.get(dateStr);

    if (CLI_OPTIONS.overwrite) {
      dates.push({ date: dateStr, reason: "overwrite mode" });
    } else if (CLI_OPTIONS.parameter) {
      // Only process if parameter is missing or null
      if (
        existing &&
        !existing[CLI_OPTIONS.parameter as keyof HistoricalRecord]
      ) {
        dates.push({
          date: dateStr,
          reason: `missing ${CLI_OPTIONS.parameter}`,
        });
      }
    } else {
      // Default: only process missing dates
      if (!existing) {
        dates.push({ date: dateStr, reason: "missing date" });
      }
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return dates;
}

// ===================================
// Time Estimation
// ===================================

function calculateEstimatedTime(start: Date, end: Date): string {
  const days = Math.ceil(
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
  );
  const queriesPerDay = 8; // Rough estimate (varies based on dev addresses count)
  const totalQueries = days * queriesPerDay;
  const secondsPerQuery = 0.5; // 2 queries/second
  const totalSeconds = totalQueries * secondsPerQuery;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  return `${hours}h ${minutes}m (${days} days, ~${totalQueries} queries)`;
}

function _addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// ===================================
// Main Population Logic
// ===================================

async function populateHistoricalData(): Promise<HistoricalRecord[]> {
  // Load existing data
  let existingData: HistoricalRecord[] = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
    } catch (_error: unknown) {
      logger.warn("Failed to load existing data, treating as empty");
    }
  }

  // Build map for quick lookups
  const dataMap = new Map<string, HistoricalRecord>();
  for (const record of existingData) {
    const date = record.timestamp.split("T")[0];
    dataMap.set(date, record);
  }

  // Determine which dates to process
  const datesToProcess = getDatesToProcess();
  const errors: Array<{ date: string; error: string }> = [];

  logger.info(
    `\n${"=".repeat(60)}\nStarting Historical Data Population\n${"=".repeat(60)}`
  );
  logger.info(
    `Mode: ${CLI_OPTIONS.overwrite ? "OVERWRITE" : CLI_OPTIONS.parameter ? `PARAMETER (${CLI_OPTIONS.parameter})` : "FILL MISSING"}`
  );
  logger.info(`Date range: ${CLI_OPTIONS.startDate} to ${CLI_OPTIONS.endDate}`);
  logger.info(`Dates to process: ${datesToProcess.length}`);

  if (datesToProcess.length === 0) {
    logger.info(`\n✓ No dates need processing!`);
    return existingData;
  }

  const startDate = new Date(datesToProcess[0].date);
  const endDate = new Date(datesToProcess[datesToProcess.length - 1].date);
  logger.info(`Estimated time: ~${calculateEstimatedTime(startDate, endDate)}`);
  logger.info(`${"=".repeat(60)}\n`);

  let processedCount = 0;

  for (const { date: dateStr, reason } of datesToProcess) {
    try {
      logger.info(
        `\n[${"=".repeat(3)} Processing ${dateStr} (${reason}) ${"=".repeat(3)}]`
      );

      // Step 1: Get block height for this date
      const height = await (async () => {
        const { getBlockHeightForDate } = await import("./lib/archive-node");
        return getBlockHeightForDate(dateStr);
      })();

      logger.info(`  Block height: ${height}`);

      // If parameter mode, only fetch that specific parameter
      if (CLI_OPTIONS.parameter) {
        logger.info(`  Fetching ${CLI_OPTIONS.parameter}...`);

        const existingRecord = dataMap.get(dateStr);
        if (!existingRecord) {
          throw new Error(`No existing record found for ${dateStr}`);
        }

        // Fetch only the requested parameter
        if (CLI_OPTIONS.parameter === "totalStaked") {
          const totalStaked = await fetchTotalStaked(dateStr, height);
          if (totalStaked !== null) {
            existingRecord.totalStaked = totalStaked;
            dataMap.set(dateStr, existingRecord);
            logger.info(
              `  ✓ Updated totalStaked: ${totalStaked.toFixed(2)} OSMO`
            );
          } else {
            throw new Error("Failed to fetch totalStaked");
          }
        } else {
          throw new Error(`Unsupported parameter: ${CLI_OPTIONS.parameter}`);
        }
      } else {
        // Full record mode: Fetch all data sequentially to avoid rate limits
        logger.info("  Fetching data...");
        const mintedSupply = await fetchMintedSupply(dateStr);
        const burnedSupply = await fetchBurnedSupply(dateStr);
        const communityPool = await fetchCommunityPool(dateStr, height);
        const distributionParams = await fetchDistributionParams(
          dateStr,
          height
        );
        const epochProvisions = await fetchEpochProvisions(dateStr, height);
        const chainInflation = await fetchChainInflation(dateStr, height);
        const totalStaked = await fetchTotalStaked(dateStr, height);
        const lockedBalances = await fetchLockedBalances(dateStr, height);

        // Step 3: Calculate derived values
        const totalSupply = mintedSupply - burnedSupply;

        // Restricted supply (chain methodology): restricted-address liquid +
        // staked, plus the developer-vesting module balance (the dev-vesting
        // module account is included in the static restricted address set, so it
        // is captured in the liquid sum). The archive node serves historical
        // delegations correctly (verified per-height), so the staked portion is
        // accurate per-date, not a current-value approximation. Community pool is
        // reported as its own bucket and excluded here.
        const totalLiquidLocked = Object.values(lockedBalances.liquid).reduce(
          (a, b) => a + b,
          0
        );
        const totalDevVestingLocked = Object.values(
          lockedBalances.devVesting
        ).reduce((a, b) => a + b, 0);
        // Restricted = real liquid + dev-vesting (both fetched per-date) + staked.
        // When the staked portion can't be read (2023 "invalid denom" window),
        // we STILL record the liquid+dev-vesting base (it's real and dominant)
        // and flag restrictedStakedPending so the reconstructed staked ramps
        // (foundation + strategic wallet) get overlaid onto these dates after the
        // backfill. This avoids blanking the whole early window just because the
        // smaller staked piece is unreadable.
        const restrictedStakedPending = lockedBalances.stakedUnavailable;
        const restrictedSupply =
          totalLiquidLocked + lockedBalances.staked + totalDevVestingLocked;

        // Circulating (public float) = total - restricted - community. When staked
        // is pending it is provisional (slightly high) until the overlay adds it.
        const circulatingSupply =
          totalSupply - restrictedSupply - communityPool;

        logger.info(
          `  Restricted: ${restrictedSupply.toLocaleString()} OSMO (liquid ${totalLiquidLocked.toLocaleString()} + staked ${lockedBalances.staked.toLocaleString()}${restrictedStakedPending ? " [staked PENDING overlay]" : ""} + devVest ${totalDevVestingLocked.toLocaleString()})`
        );
        logger.info(`  Community pool: ${communityPool.toLocaleString()} OSMO`);

        // Inflation: prefer the chain's OWN reported value (authoritative,
        // matches what the chain uses and avoids any formula-reconstruction
        // risk). Fall back to recomputing from provisions/params/supply only if
        // the chain inflation query is unavailable at this height.
        let inflationRate = 0;
        if (chainInflation !== null) {
          inflationRate = chainInflation;
        } else if (distributionParams && epochProvisions) {
          inflationRate = calculateInflationRate(
            distributionParams,
            epochProvisions,
            totalSupply
          );
          logger.info(
            `  Chain inflation unavailable; recomputed = ${inflationRate.toFixed(3)}%`
          );
        } else {
          logger.warn(
            `  No chain inflation and missing params/provisions for ${dateStr}, inflation rate = 0`
          );
        }

        // Step 4: Create or update historical record
        const record: HistoricalRecord = {
          timestamp: `${dateStr}T17:20:00.000Z`,
          mintedSupply,
          burnedSupply,
          totalSupply,
          circulatingSupply,
          restrictedSupply,
          restrictedStakedPending: restrictedStakedPending || undefined,
          communitySupply: communityPool,
          inflationRate,
          totalStaked: totalStaked || undefined,
          distributionProportions: distributionParams
            ? {
                staking: distributionParams.staking,
                poolIncentives: distributionParams.poolIncentives,
                developerRewards: distributionParams.developerRewards,
                communityPool: distributionParams.communityPool,
              }
            : undefined,
        };

        dataMap.set(dateStr, record);
        logger.info(
          `  ✓ Record ${dataMap.has(dateStr) ? "updated" : "created"} for ${dateStr}`
        );
        logger.info(`    Supply: ${totalSupply.toLocaleString()} OSMO`);
        logger.info(
          `    Circulating: ${circulatingSupply === undefined ? "(pending interpolation)" : circulatingSupply.toLocaleString() + " OSMO"}`
        );
        logger.info(`    Inflation: ${inflationRate.toFixed(2)}%`);
      }

      processedCount++;

      // Step 5: Save checkpoint periodically
      if (processedCount % CHECKPOINT_INTERVAL === 0) {
        const currentData = Array.from(dataMap.values()).sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        // Also save records to file (incremental backup)
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(currentData, null, 2));
        logger.info(
          `  ✓ Progress saved: ${processedCount}/${datesToProcess.length} processed, ${dataMap.size} total records\n`
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`  ✗ Error processing ${dateStr}:`, message);
      errors.push({ date: dateStr, error: message });

      // Continue to next date (don't stop entire process)
    }
  }

  // Convert map to sorted array
  const finalRecords = Array.from(dataMap.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Final save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalRecords, null, 2));

  logger.info(`\n${"=".repeat(60)}`);
  logger.info("Population Complete");
  logger.info(`${"=".repeat(60)}`);
  logger.info(`Total records: ${finalRecords.length}`);
  logger.info(`Processed: ${processedCount}`);
  logger.info(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    logger.warn("\nDates with errors:");
    errors.forEach((e) => logger.warn(`  ${e.date}: ${e.error}`));
  }

  return finalRecords;
}

// ===================================
// CLI Entry Point
// ===================================

async function main() {
  try {
    console.log("=".repeat(60));
    console.log("Osmosis Historical Data Population");
    console.log("Archive Node: https://lcd.archive.osmosis.zone");
    console.log("=".repeat(60));

    // Populate/update historical data
    const records = await populateHistoricalData();

    // Export epoch block heights to CSV
    const csvPath = path.join(process.cwd(), "data", "epoch-block-heights.csv");
    exportEpochCacheToCSV(csvPath);

    console.log("\n✓ Success! Historical data has been populated.");
    console.log(`\n📄 Data saved to: ${OUTPUT_FILE}`);
    console.log(`📊 Epoch block heights exported to: ${csvPath}`);
    console.log(`\nTotal records: ${records.length}`);

    if (records.length > 0) {
      const dateRange = `${records[0].timestamp.split("T")[0]} to ${records[records.length - 1].timestamp.split("T")[0]}`;
      console.log(`Date range: ${dateRange}`);
    }

    console.log("\nNext steps:");
    console.log(
      "  1. Normalize supply offset: yarn tsx scripts/normalize-supply-offset.ts"
    );
    console.log(
      "     (REQUIRED after any backfill: this script writes RAW pre-v27 by_denom"
    );
    console.log(
      "      values; normalize applies the retroactive v27 offset + artifact repair"
    );
    console.log(
      "      so the series matches the chain's current methodology. Idempotent.)"
    );
    console.log("  2. Run validation: yarn validate-history");
    console.log("  3. Commit to GitHub: git add data/ && git commit");
  } catch (error: unknown) {
    console.error("\n✗ Fatal error:", error);
    process.exit(1);
  }
}

main();
