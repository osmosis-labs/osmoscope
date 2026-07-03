import fs from "fs/promises";
import path from "path";
import { logger } from "./logger";
import { isDatabaseEnabled } from "./database";
import {
  saveSnapshotToDatabase,
  getHistoryFromDatabase,
  getHistoryRangeFromDatabase,
  getHistoryStatsFromDatabase,
  getBurnRateFromDatabase,
} from "./historical-file-db";

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// Write lock to prevent concurrent file writes (race condition protection)
let writeQueue: Promise<unknown> = Promise.resolve();
function lockWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => undefined); // Continue queue even if this write fails
  return result;
}

export interface HistoricalRecord {
  timestamp: string;
  dayEpoch?: number; // Chain "day" epoch number this snapshot was taken for (set by the live snapshot; absent on archive-backfilled rows).
  burnedSupply: number;
  mintedSupply: number;
  totalSupply: number; // Calculated as mintedSupply - burnedSupply
  circulatingSupply?: number; // Unset for the 2023 upgrade window where staked (hence restricted/circulating) can't be read; interpolated post-backfill.
  restrictedSupply?: number; // Chain-methodology restricted supply (dev-vesting + restricted-address liquid+staked).
  restrictedStakedPending?: boolean; // True when the staked portion couldn't be read (2023 invalid-denom window); the value holds liquid+devVesting only until the reconstructed staked ramp is overlaid.
  communitySupply?: number; // Community pool OSMO (live + archive backfill).
  inflationRate: number;
  totalStaked?: number; // Total bonded tokens from staking pool
  stakingApr?: number; // Raw APR for this specific date
  stakingRate?: number; // 30-day average APR
  // Revenue distribution parameters
  distributionProportions?: {
    staking: string;
    poolIncentives: string;
    developerRewards: string;
    communityPool: string;
  };
  osmoTakerFeeDistribution?: {
    stakingRewards: string;
    communityPool: string;
    burn?: string;
  };
  nonOsmoTakerFeeDistribution?: {
    stakingRewards: string;
    communityPool: string;
    burn?: string;
  };
  communityPoolDenomWhitelist?: string[];
  communityPoolDenomToSwapNonWhitelistedAssetsTo?: string;
  // Protocol revenue fields (daily values in USD)
  txnFeesRevenue?: number;
  takerFeesRevenue?: number;
  protorevRevenue?: number;
  mevRevenue?: number;
  totalRevenue?: number;
  // Data-provenance markers, set by the one-off migration scripts to make them
  // idempotent. Persisted so a migration re-run over DB-exported JSON cannot
  // double-apply (e.g. subtract the v27 supply offset twice).
  supplyOffsetNormalized?: boolean;
  genesisBackfilled?: boolean;
  inflationRecomputed?: boolean;
  // Legacy fields for backwards compatibility
  burned?: number;
  circulating?: number;
}

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory already exists, ignore
  }
}

// Decide whether to persist an incoming snapshot. Timing is owned by the
// epoch-aware cron (it only calls in once a new day-epoch is live), so this no
// longer gates on wall-clock time. Deduplication:
//   - if the record carries a dayEpoch: skip only if a snapshot for that EXACT
//     epoch already exists (a true duplicate). A same-calendar-day row with a
//     DIFFERENT/absent epoch is allowed through — it's a refresh, and saveSnapshot
//     replaces the existing same-day row (on both the file and DB paths) rather
//     than appending, so no duplicate accumulates.
//   - if the record has no dayEpoch: dedup by calendar day, since there is no
//     other key to dedup on.
async function shouldSaveSnapshot(
  currentData: HistoricalRecord
): Promise<boolean> {
  const history = await getHistory();
  if (history.length === 0) {
    logger.info("No history found, saving first snapshot");
    return true;
  }

  if (currentData.dayEpoch != null) {
    const exists = history.some((r) => r.dayEpoch === currentData.dayEpoch);
    if (exists) {
      logger.info(
        `Snapshot for epoch ${currentData.dayEpoch} already exists, skipping`
      );
      return false;
    }
    return true; // new epoch — allow; same-day replacement happens at save time
  }

  // No epoch on the record: dedup by calendar day (UTC).
  const now = new Date(currentData.timestamp);
  const sameDayExists = history.some((r) => {
    const d = new Date(r.timestamp);
    return (
      d.getUTCFullYear() === now.getUTCFullYear() &&
      d.getUTCMonth() === now.getUTCMonth() &&
      d.getUTCDate() === now.getUTCDate()
    );
  });
  if (sameDayExists) {
    logger.info("Snapshot for this day already exists, skipping");
    return false;
  }
  return true;
}

// Save a new snapshot (checks if we should save first). Returns true if a row was
// persisted, false ONLY when the snapshot was intentionally skipped (dedup). A
// genuine storage error THROWS rather than returning false, so the caller/cron
// can report a real failure (HTTP 500) instead of masking it as a deduped run —
// otherwise a failed write is indistinguishable from a skip until the next epoch.
export async function saveSnapshot(data: HistoricalRecord): Promise<boolean> {
  // Use write lock to prevent race conditions
  return lockWrite(async () => {
    try {
      // Override daily dedup when this snapshot carries taker-fee distribution
      // params that the latest stored row lacks: those params feed the fee-flow
      // chart, and without this a same-day re-run (which dedup would skip) would
      // never persist them. Fires at most once (until a row has the params).
      const existingHistory = await getHistory();
      const latestRecord = existingHistory[existingHistory.length - 1];
      const forceSave =
        data.osmoTakerFeeDistribution &&
        !latestRecord?.osmoTakerFeeDistribution;

      // Check if we should save this snapshot
      const shouldSave = forceSave || (await shouldSaveSnapshot(data));
      if (!shouldSave) {
        return false; // Skipped (dedup)
      }

      // Use database if enabled (priority 1)
      if (isDatabaseEnabled()) {
        logger.info("Using database storage");
        await saveSnapshotToDatabase(data);
        return true;
      }

      // Fall back to local file storage (priority 2)
      logger.info("Using local file storage");
      await ensureDataDir();

      // Read existing history
      let history: HistoricalRecord[] = [];
      try {
        const content = await fs.readFile(HISTORY_FILE, "utf-8");
        history = JSON.parse(content);
      } catch {
        // File doesn't exist yet, start with empty array
        logger.info("Creating new history file...");
      }

      // Check if this is a retry attempt - remove today's old snapshot if exists
      const now = new Date(data.timestamp);
      history = history.filter((record) => {
        const recordDate = new Date(record.timestamp);
        const isSameDay =
          recordDate.getUTCFullYear() === now.getUTCFullYear() &&
          recordDate.getUTCMonth() === now.getUTCMonth() &&
          recordDate.getUTCDate() === now.getUTCDate();
        return !isSameDay; // Remove any snapshots from today
      });

      // Add new snapshot
      history.push(data);

      // Sort by timestamp to maintain chronological order
      history.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Save back to file
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
      logger.info(`Saved snapshot. Total records: ${history.length}`);
      return true;
    } catch (error) {
      // A storage error is NOT a dedup skip: log and rethrow so the cron surfaces
      // it as a failure rather than a misleading saved:false.
      logger.error("Failed to save snapshot:", error);
      throw error;
    }
  });
}

// Sort records ascending by timestamp. Consumers (metrics KPIs, burnRateOver,
// recentIdx/findIndex, the net-inflation loop) all ASSUME ascending order, so we
// guarantee it here at the read boundary rather than trusting each source: the DB
// path already orders asc, but the file fallback returns parsed JSON as-is, and a
// hand-edited or out-of-order file would otherwise miscompute window endpoints.
function sortByTimestampAsc(records: HistoricalRecord[]): HistoricalRecord[] {
  return [...records].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

// Get all historical records (always ascending by timestamp).
export async function getHistory(): Promise<HistoricalRecord[]> {
  // Use database if enabled (priority 1)
  if (isDatabaseEnabled()) {
    try {
      return sortByTimestampAsc(await getHistoryFromDatabase());
    } catch (error) {
      logger.error("Failed to fetch from database, falling back:", error);
      // Fall through to local file storage
    }
  }

  // Use local file storage (priority 2)
  try {
    const content = await fs.readFile(HISTORY_FILE, "utf-8");
    return sortByTimestampAsc(JSON.parse(content));
  } catch {
    // File doesn't exist yet
    return [];
  }
}

// Get history for a specific time range
export async function getHistoryRange(
  days: number
): Promise<HistoricalRecord[]> {
  // Use database if enabled (priority 1) - most efficient with WHERE clause
  if (isDatabaseEnabled()) {
    try {
      return await getHistoryRangeFromDatabase(days);
    } catch (error) {
      logger.error("Failed to fetch range from database, falling back:", error);
      // Fall through to filtering all records
    }
  }

  // Fall back to filtering all records (priority 2)
  const history = await getHistory();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return history.filter(
    (record) => new Date(record.timestamp).getTime() > cutoff
  );
}

// Calculate burn rate from historical data
export async function getBurnRateFromHistory(
  days: number = 1
): Promise<number> {
  // Use database if enabled (more efficient query)
  if (isDatabaseEnabled()) {
    try {
      return await getBurnRateFromDatabase(days);
    } catch (error) {
      logger.error(
        "Failed to calculate burn rate from database, falling back:",
        error
      );
      // Fall through to JSON-based calculation
    }
  }

  const history = await getHistory();

  if (history.length < 2) {
    logger.info("Not enough historical data to calculate burn rate");
    return 0;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recentHistory = history.filter(
    (record) => new Date(record.timestamp).getTime() > cutoff
  );

  if (recentHistory.length < 2) {
    logger.info(
      `Need at least 2 data points in last ${days} days. Have: ${recentHistory.length}`
    );
    return 0;
  }

  // Get oldest and newest in the range
  const oldest = recentHistory[0];
  const newest = recentHistory[recentHistory.length - 1];

  const burnChange =
    (newest.burnedSupply || newest.burned || 0) -
    (oldest.burnedSupply || oldest.burned || 0);

  // Calculate the actual time span between oldest and newest
  const timeSpanMs =
    new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime();
  const timeSpanDays = timeSpanMs / (1000 * 60 * 60 * 24);

  // Calculate as annualized percentage of total supply (to match inflation rate)
  if (newest.totalSupply > 0 && burnChange !== 0 && timeSpanDays > 0) {
    // Annualize the burn rate (change per year)
    const annualizedBurnChange = (burnChange / timeSpanDays) * 365;
    const rate = -(annualizedBurnChange / newest.totalSupply) * 100;
    logger.info(
      `Burn rate: ${rate.toFixed(4)}% annually (${burnChange.toFixed(2)} OSMO over ${timeSpanDays.toFixed(1)} days)`
    );
    return rate;
  }

  return 0;
}

// Get stats about the historical data
export async function getHistoryStats() {
  // Use database if enabled (most efficient with aggregation queries)
  if (isDatabaseEnabled()) {
    try {
      return await getHistoryStatsFromDatabase();
    } catch (error) {
      logger.error("Failed to get stats from database, falling back:", error);
      // Fall through to local implementation
    }
  }

  const history = await getHistory();

  if (history.length === 0) {
    return {
      recordCount: 0,
      oldestRecord: null,
      newestRecord: null,
      coverageDays: 0,
    };
  }

  const oldest = new Date(history[0].timestamp);
  const newest = new Date(history[history.length - 1].timestamp);
  const coverageDays =
    (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24);

  return {
    recordCount: history.length,
    oldestRecord: oldest.toISOString(),
    newestRecord: newest.toISOString(),
    coverageDays: Math.round(coverageDays * 10) / 10,
  };
}
