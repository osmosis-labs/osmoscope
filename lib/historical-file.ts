import fs from "fs/promises";
import path from "path";
import { logger } from "./logger";
import {
  isGitHubStorageEnabled,
  getHistoryFromGitHub,
  getHistoryRangeFromGitHub,
  saveSnapshotToGitHub,
  getHistoryStatsFromGitHub,
} from "./github-storage";

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
  burnedSupply: number;
  mintedSupply: number;
  totalSupply: number; // Calculated as mintedSupply - burnedSupply
  circulatingSupply: number;
  restrictedSupply?: number; // Modeled value (97046470)
  communitySupply?: number; // Modeled value (89137083)
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
  // Legacy fields for backwards compatibility
  burned?: number;
  circulating?: number;
}

// Target time for daily snapshot: 17:20 UTC
const SNAPSHOT_HOUR = 17;
const SNAPSHOT_MINUTE = 20;

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory already exists, ignore
  }
}

// Check if two snapshots have meaningful differences
function hasSignificantChange(
  snapshot1: HistoricalRecord,
  snapshot2: HistoricalRecord
): boolean {
  // Check if burned amount changed (even slightly)
  const burnedChanged =
    Math.abs(
      (snapshot1.burnedSupply || snapshot1.burned || 0) -
        (snapshot2.burnedSupply || snapshot2.burned || 0)
    ) > 0.1;

  // Check if total supply changed
  const supplyChanged =
    Math.abs(snapshot1.totalSupply - snapshot2.totalSupply) > 100;

  return burnedChanged || supplyChanged;
}

// Check if we should save a snapshot
async function shouldSaveSnapshot(
  currentData: HistoricalRecord
): Promise<boolean> {
  const history = await getHistory();

  // If no history, save first snapshot
  if (history.length === 0) {
    logger.info("No history found, saving first snapshot");
    return true;
  }

  // Get the last snapshot
  const lastSnapshot = history[history.length - 1];
  const lastDate = new Date(lastSnapshot.timestamp);
  const now = new Date();

  // Check if we already have a snapshot from today
  const isSameDay =
    lastDate.getUTCFullYear() === now.getUTCFullYear() &&
    lastDate.getUTCMonth() === now.getUTCMonth() &&
    lastDate.getUTCDate() === now.getUTCDate();

  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  if (isSameDay) {
    // We have a snapshot from today - check if it has meaningful changes
    const hasChanges = hasSignificantChange(lastSnapshot, currentData);

    if (!hasChanges) {
      // Data hasn't changed - check if we should retry
      const timeSinceLastSnapshot = now.getTime() - lastDate.getTime();
      const minutesSinceLastSnapshot = timeSinceLastSnapshot / (1000 * 60);

      // If it's been more than 10 minutes since last check, retry
      if (minutesSinceLastSnapshot >= 10) {
        logger.info(
          `No change in last ${minutesSinceLastSnapshot.toFixed(1)} minutes, retrying snapshot`
        );
        return true;
      }

      logger.info(
        `No change yet, will retry in ${(10 - minutesSinceLastSnapshot).toFixed(1)} minutes`
      );
      return false;
    }

    // Data has changed, we already have today's meaningful snapshot
    logger.info("Already have meaningful snapshot for today, skipping");
    return false;
  }

  // Different day - check if we're within or past the target time
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const targetTotalMinutes = SNAPSHOT_HOUR * 60 + SNAPSHOT_MINUTE;

  // Save if we're at or past 17:20 UTC
  if (currentTotalMinutes >= targetTotalMinutes - 5) {
    logger.info(
      `At or past target time (${currentHour}:${currentMinute} UTC), saving snapshot`
    );
    return true;
  }

  logger.info(
    `Before target time (current: ${currentHour}:${currentMinute} UTC, target: ${SNAPSHOT_HOUR}:${SNAPSHOT_MINUTE} UTC), skipping`
  );
  return false;
}

// Save a new snapshot (checks if we should save first)
export async function saveSnapshot(data: HistoricalRecord): Promise<void> {
  // Use write lock to prevent race conditions
  return lockWrite(async () => {
    try {
      // TEMPORARY: Force save if we have distribution parameters but they're not in history
      const existingHistory = await getHistory();
      const latestRecord = existingHistory[existingHistory.length - 1];
      const forceSave =
        data.osmoTakerFeeDistribution &&
        !latestRecord?.osmoTakerFeeDistribution;

      // Check if we should save this snapshot
      const shouldSave = forceSave || (await shouldSaveSnapshot(data));
      if (!shouldSave) {
        return; // Skip saving
      }

      // Use GitHub storage if enabled, otherwise use local file storage
      if (isGitHubStorageEnabled()) {
        logger.info("Using GitHub storage");
        await saveSnapshotToGitHub(data);
        return;
      }

      // Fall back to local file storage
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
      history.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Save back to file
      await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
      logger.info(`Saved snapshot. Total records: ${history.length}`);
    } catch (error) {
      logger.error("Failed to save snapshot:", error);
    }
  });
}

// Get all historical records
export async function getHistory(): Promise<HistoricalRecord[]> {
  // Use GitHub storage if enabled, otherwise use local file storage
  if (isGitHubStorageEnabled()) {
    try {
      return await getHistoryFromGitHub();
    } catch (error) {
      logger.error("Failed to fetch from GitHub, falling back to local file:", error);
      // Fall through to local file storage
    }
  }

  // Use local file storage
  try {
    const content = await fs.readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    // File doesn't exist yet
    return [];
  }
}

// Get history for a specific time range
export async function getHistoryRange(
  days: number
): Promise<HistoricalRecord[]> {
  // Use GitHub storage if enabled for potential optimization
  if (isGitHubStorageEnabled()) {
    try {
      return await getHistoryRangeFromGitHub(days);
    } catch (error) {
      logger.error("Failed to fetch range from GitHub, falling back to getHistory:", error);
      // Fall through to regular getHistory
    }
  }

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
  // Use GitHub storage if enabled
  if (isGitHubStorageEnabled()) {
    try {
      return await getHistoryStatsFromGitHub();
    } catch (error) {
      logger.error("Failed to get stats from GitHub, falling back:", error);
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
