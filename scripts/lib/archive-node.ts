import fs from "fs";
import path from "path";
import { logger } from "../../lib/logger";

// Archive node configuration
const ARCHIVE_NODE_URL = "https://lcd.archive.osmosis.zone";
const REQUESTS_PER_SECOND = 0.5; // Very conservative to avoid rate limits
const DELAY_MS = 1000 / REQUESTS_PER_SECOND; // 2000ms between requests

// Epoch cache file
const EPOCH_CACHE_FILE = path.join(process.cwd(), "data", "epoch-block-cache.json");

// Track last request time for rate limiting
let lastRequestTime = 0;

// ===================================
// Types & Interfaces
// ===================================

export interface EpochInfo {
  identifier: string;
  start_time: string;
  duration: string;
  current_epoch: string;
  current_epoch_start_time: string;
  current_epoch_start_height: string;
  epoch_counting_started: boolean;
}

export interface EpochCache {
  [date: string]: {
    blockHeight: number;
    epochNumber?: number; // Legacy field, no longer used
  };
}

// ===================================
// Utility Functions
// ===================================

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===================================
// Epoch Cache Management
// ===================================

export function loadEpochCache(): EpochCache {
  try {
    if (fs.existsSync(EPOCH_CACHE_FILE)) {
      const content = fs.readFileSync(EPOCH_CACHE_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    logger.warn("Failed to load epoch cache, starting fresh:", error);
  }
  return {};
}

export function saveEpochCache(cache: EpochCache): void {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(EPOCH_CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(EPOCH_CACHE_FILE, JSON.stringify(cache, null, 2));
    logger.debug("Epoch cache saved");
  } catch (error) {
    logger.error("Failed to save epoch cache:", error);
  }
}

export function exportEpochCacheToCSV(outputPath: string): void {
  try {
    const cache = loadEpochCache();
    const entries = Object.entries(cache).sort((a, b) => a[0].localeCompare(b[0]));

    // Create CSV content
    const csvLines = [
      "date,block_height", // Header
      ...entries.map(([date, data]) => `${date},${data.blockHeight}`)
    ];

    const csvContent = csvLines.join("\n");
    fs.writeFileSync(outputPath, csvContent);

    logger.info(`Exported ${entries.length} epoch block heights to ${outputPath}`);
  } catch (error) {
    logger.error("Failed to export epoch cache to CSV:", error);
    throw error;
  }
}

// ===================================
// Throttled Archive Node Client
// ===================================

export async function throttledFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  // Ensure we don't exceed rate limit
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < DELAY_MS) {
    await sleep(DELAY_MS - timeSinceLastRequest);
  }

  lastRequestTime = Date.now();
  return fetch(url, options);
}

export async function queryArchiveNode<T>(
  endpoint: string,
  height?: number
): Promise<T> {
  const url = `${ARCHIVE_NODE_URL}${endpoint}`;

  // Use x-cosmos-block-height header instead of query parameter for historical queries
  const headers: Record<string, string> = {};
  if (height) {
    headers["x-cosmos-block-height"] = height.toString();
  }

  logger.debug(
    `Querying: ${endpoint}${height ? ` at height ${height}` : ""}`
  );

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await throttledFetch(url, { headers });

      if (response.status === 429) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        logger.warn(`Rate limited, backing off ${backoffMs}ms...`);
        await sleep(backoffMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (_error: unknown) {
      if (attempt === 3) {
        logger.error(`Failed after 3 attempts: ${url}`, error);
        throw error;
      }
      logger.warn(`Attempt ${attempt} failed, retrying...`);
      await sleep(1000);
    }
  }

  throw new Error("Unreachable");
}

/**
 * Query archive node with fallback to nearby blocks
 * If the target height fails, tries nearby blocks (±10, ±100, ±500) as approximation
 * Returns both the data and the actual height used (for pagination support)
 */
export async function queryArchiveNodeWithFallbackAndHeight<T>(
  endpoint: string,
  targetDate: string,
  targetHeight: number
): Promise<{ data: T; height: number } | null> {
  // Try target height first
  try {
    const data = await queryArchiveNode<T>(endpoint, targetHeight);
    return { data, height: targetHeight };
  } catch (_error: unknown) {
    logger.warn(
      `Failed to query ${endpoint} at height ${targetHeight}, trying nearby blocks...`
    );
  }

  // Try progressively larger offsets: ±10, ±100, ±500 blocks
  const offsets = [10, 100, 500];

  for (const offset of offsets) {
    // Try earlier blocks first (more likely to have data)
    try {
      const earlierHeight = targetHeight - offset;
      logger.info(`  Trying ${offset} blocks earlier: ${earlierHeight}`);
      const data = await queryArchiveNode<T>(endpoint, earlierHeight);
      return { data, height: earlierHeight };
    } catch (_error: unknown) {
      logger.warn(`  Block -${offset} failed`);
    }

    // Try later blocks
    try {
      const laterHeight = targetHeight + offset;
      logger.info(`  Trying ${offset} blocks later: ${laterHeight}`);
      const data = await queryArchiveNode<T>(endpoint, laterHeight);
      return { data, height: laterHeight };
    } catch (_error: unknown) {
      logger.warn(`  Block +${offset} failed`);
    }
  }

  // All attempts failed
  logger.error(
    `All attempts failed for ${endpoint} at ${targetDate} (height ${targetHeight})`
  );
  return null;
}

/**
 * Query archive node with fallback to nearby blocks (legacy version)
 * Returns only the data, not the height used
 */
export async function queryArchiveNodeWithFallback<T>(
  endpoint: string,
  targetDate: string,
  targetHeight: number
): Promise<T | null> {
  const result = await queryArchiveNodeWithFallbackAndHeight<T>(
    endpoint,
    targetDate,
    targetHeight
  );
  return result ? result.data : null;
}

// ===================================
// Epoch Resolution
// ===================================

interface BlockHeader {
  height: string;
  time: string;
}

async function queryBlockHeader(height: number): Promise<BlockHeader> {
  // Try the exact height first
  try {
    const response = await queryArchiveNode<{
      block: { header: BlockHeader };
    }>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`);

    return response.block.header;
  } catch (_error: unknown) {
    logger.warn(`Failed to query block ${height}, trying nearby blocks...`);
  }

  // Try nearby blocks with smaller offsets for block header queries
  const offsets = [1, 5, 10, 50];

  for (const offset of offsets) {
    // Try earlier block first
    try {
      const earlierHeight = height - offset;
      if (earlierHeight > 0) {
        logger.debug(`  Trying block ${earlierHeight} (${offset} blocks earlier)`);
        const response = await queryArchiveNode<{
          block: { header: BlockHeader };
        }>(`/cosmos/base/tendermint/v1beta1/blocks/${earlierHeight}`);

        return response.block.header;
      }
    } catch (_error: unknown) {
      // Continue to next offset
    }

    // Try later block
    try {
      const laterHeight = height + offset;
      logger.debug(`  Trying block ${laterHeight} (${offset} blocks later)`);
      const response = await queryArchiveNode<{
        block: { header: BlockHeader };
      }>(`/cosmos/base/tendermint/v1beta1/blocks/${laterHeight}`);

      return response.block.header;
    } catch (_error: unknown) {
      // Continue to next offset
    }
  }

  throw new Error(`All block header queries failed for height ${height}`);
}

async function interpolationSearchBlockByTimestamp(
  targetTime: Date,
  minHeight: number,
  maxHeight: number,
  _avgBlockTimeMs: number
): Promise<number> {
  logger.debug(
    `Interpolation search for timestamp ${targetTime.toISOString()} between blocks ${minHeight}-${maxHeight}`
  );

  let low = minHeight;
  let high = maxHeight;
  let result = low;
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (low <= high && iterations < MAX_ITERATIONS) {
    iterations++;

    // Use interpolation to guess position
    const lowHeader = await queryBlockHeader(low);
    const highHeader = await queryBlockHeader(high);
    const lowTime = new Date(lowHeader.time);
    const highTime = new Date(highHeader.time);

    logger.debug(
      `Iteration ${iterations}: Range ${low} (${lowTime.toISOString()}) to ${high} (${highTime.toISOString()})`
    );

    // If target is outside range, return boundary
    if (targetTime <= lowTime) {
      return low;
    }
    if (targetTime >= highTime) {
      return high;
    }

    // Interpolate position based on time
    const totalTimeRange = highTime.getTime() - lowTime.getTime();
    const targetOffset = targetTime.getTime() - lowTime.getTime();
    const ratio = targetOffset / totalTimeRange;
    const guess = Math.floor(low + ratio * (high - low));

    // Clamp guess to range
    const clampedGuess = Math.max(low, Math.min(high, guess));

    const guessHeader = await queryBlockHeader(clampedGuess);
    const guessTime = new Date(guessHeader.time);
    const timeDiffMs = targetTime.getTime() - guessTime.getTime();
    const timeDiffSec = timeDiffMs / 1000;

    logger.debug(
      `Block ${clampedGuess}: ${guessTime.toISOString()} (${timeDiffSec > 0 ? '+' : ''}${timeDiffSec.toFixed(0)}s from target)`
    );

    // If we're very close (within 30 seconds), fine-tune with linear search
    if (Math.abs(timeDiffSec) <= 30) {
      // Find the last block <= target
      let finalBlock = clampedGuess;
      if (guessTime <= targetTime) {
        // Search forward to find last block before target
        for (let i = clampedGuess; i <= Math.min(clampedGuess + 10, high); i++) {
          const h = await queryBlockHeader(i);
          const t = new Date(h.time);
          if (t <= targetTime) {
            finalBlock = i;
          } else {
            break;
          }
        }
      } else {
        // Search backward to find last block before target
        for (let i = clampedGuess; i >= Math.max(clampedGuess - 10, low); i--) {
          const h = await queryBlockHeader(i);
          const t = new Date(h.time);
          if (t <= targetTime) {
            finalBlock = i;
            break;
          }
        }
      }
      return finalBlock;
    }

    // Adjust search range
    if (guessTime < targetTime) {
      // Target is later, search higher
      result = clampedGuess;
      low = clampedGuess + 1;
    } else {
      // Target is earlier, search lower
      high = clampedGuess - 1;
    }
  }

  logger.warn(`Search reached max iterations (${MAX_ITERATIONS}), returning ${result}`);
  return result;
}

async function findBlockHeightForDate(date: string): Promise<number> {
  // Target: end of day (23:59:59 UTC) to capture full day including downtime/upgrades
  const targetTime = new Date(date + "T23:59:59.999Z");

  logger.info(`Finding block height for ${date} (${targetTime.toISOString()})`);

  // Get two reference blocks to estimate average block time
  const genesisHeader = await queryBlockHeader(1);
  const recentHeight = 50000; // Use a known recent block for estimation
  const recentHeader = await queryBlockHeader(recentHeight);

  const genesisTime = new Date(genesisHeader.time);
  const recentTime = new Date(recentHeader.time);

  // Calculate average block time from reference points
  const timeDiffMs = recentTime.getTime() - genesisTime.getTime();
  const blockDiff = recentHeight - 1;
  const avgBlockTimeMs = timeDiffMs / blockDiff;

  logger.debug(
    `Average block time: ${(avgBlockTimeMs / 1000).toFixed(2)}s per block`
  );

  // Estimate target block height
  const targetTimeDiffMs = targetTime.getTime() - genesisTime.getTime();
  const estimatedHeight = Math.floor(targetTimeDiffMs / avgBlockTimeMs);

  logger.debug(`Estimated block height: ${estimatedHeight}`);

  // Interpolation search with a window around the estimate
  const searchWindow = 5000; // +/- 5000 blocks should be more than enough
  const minHeight = Math.max(1, estimatedHeight - searchWindow);
  const maxHeight = estimatedHeight + searchWindow;

  const blockHeight = await interpolationSearchBlockByTimestamp(
    targetTime,
    minHeight,
    maxHeight,
    avgBlockTimeMs
  );

  logger.info(`Found block ${blockHeight} for date ${date}`);

  return blockHeight;
}

export async function getBlockHeightForDate(date: string): Promise<number> {
  // Check cache first
  const cache = loadEpochCache();

  if (cache[date]) {
    logger.debug(`Using cached block height for ${date}: ${cache[date].blockHeight}`);
    return cache[date].blockHeight;
  }

  // Use binary search to find block height at 23:59:59 for the date
  const blockHeight = await findBlockHeightForDate(date);

  // Cache the result
  cache[date] = { blockHeight };
  saveEpochCache(cache);

  return blockHeight;
}

// ===================================
// Data Validators
// ===================================

export function validateSupply(supply: number): boolean {
  // Osmosis launched with ~100M supply, now has ~750M
  return supply >= 100_000_000 && supply <= 1_000_000_000;
}

export function validateInflationRate(rate: number): boolean {
  // Historical inflation rate typically 5-20%
  return rate >= 0 && rate <= 25;
}

export function validateStaking(amount: number): boolean {
  // Can't stake more than total supply
  return amount >= 0 && amount <= 800_000_000;
}

export function validatePercentage(value: string | number): boolean {
  const num = typeof value === "string" ? parseFloat(value) : value;
  // Distribution proportions are decimals between 0 and 1
  return num >= 0 && num <= 1;
}
