import fs from "fs";
import path from "path";
import { logger } from "../../lib/logger";

// Archive node configuration
const ARCHIVE_NODE_URL = "https://lcd.archive.osmosis.zone";
const REQUESTS_PER_SECOND = 1.5; // Increased from 0.5 for faster processing
const DELAY_MS = 1000 / REQUESTS_PER_SECOND; // ~667ms between requests

// Epoch cache file
const EPOCH_CACHE_FILE = path.join(
  process.cwd(),
  "data",
  "epoch-block-cache.json"
);

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
    const entries = Object.entries(cache).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    // Create CSV content
    const csvLines = [
      "date,block_height", // Header
      ...entries.map(([date, data]) => `${date},${data.blockHeight}`),
    ];

    const csvContent = csvLines.join("\n");
    fs.writeFileSync(outputPath, csvContent);

    logger.info(
      `Exported ${entries.length} epoch block heights to ${outputPath}`
    );
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

  logger.debug(`Querying: ${endpoint}${height ? ` at height ${height}` : ""}`);

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

      // The archive node sits behind Cloudflare, which can return an HTTP 200
      // "Just a moment..." interstitial (HTML, not JSON) under load. Detect it
      // by content type and back off + retry rather than crashing on JSON.parse.
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        logger.warn(
          `Non-JSON response (likely Cloudflare challenge), backing off ${backoffMs}ms...`
        );
        await sleep(backoffMs);
        continue;
      }

      return await response.json();
    } catch (error: unknown) {
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
        logger.debug(
          `  Trying block ${earlierHeight} (${offset} blocks earlier)`
        );
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

  // Cache boundary timestamps: only re-query a boundary header when that
  // boundary actually moves. Over the full chain range a naive search re-queried
  // both boundaries every iteration (~3 header calls x 20 iters), which hammered
  // the archive node hard enough to trip its Cloudflare rate limit; caching cuts
  // this to roughly one header query per iteration.
  let lowTime = new Date((await queryBlockHeader(low)).time);
  let highTime = new Date((await queryBlockHeader(high)).time);

  while (low <= high && iterations < MAX_ITERATIONS) {
    iterations++;

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

    // Track the best block at or before the target seen so far, regardless of
    // which way the range narrows. Without this, a search that only ever moves
    // `high` down (target consistently earlier than the guess) would never
    // update `result` and would return the initial low bound (block 1) on
    // max-iterations.
    if (guessTime <= targetTime && clampedGuess > result) {
      result = clampedGuess;
    }

    logger.debug(
      `Block ${clampedGuess}: ${guessTime.toISOString()} (${timeDiffSec > 0 ? "+" : ""}${timeDiffSec.toFixed(0)}s from target)`
    );

    // Close enough: for a once-per-day snapshot, landing within ~10 minutes of
    // end-of-day is more than precise enough (balances do not change meaningfully
    // minute to minute), and it keeps the query count low under the archive
    // node's rate limit. The guess is within the window on either side, so return
    // it directly.
    if (Math.abs(timeDiffSec) <= 600) {
      return clampedGuess;
    }

    // Adjust search range. Reuse guessTime as the new boundary timestamp (the
    // one-block offset is negligible for interpolation and self-corrects), so we
    // avoid an extra header query per iteration.
    if (guessTime < targetTime) {
      // Target is later, search higher
      result = clampedGuess;
      low = clampedGuess + 1;
      lowTime = guessTime;
    } else {
      // Target is earlier, search lower
      high = clampedGuess - 1;
      highTime = guessTime;
    }
  }

  logger.warn(
    `Search reached max iterations (${MAX_ITERATIONS}), returning ${result}`
  );
  return result;
}

/**
 * Fetch the current chain tip height from the archive node.
 */
async function fetchLatestHeight(): Promise<number> {
  const response = await queryArchiveNode<{
    block: { header: BlockHeader };
  }>("/cosmos/base/tendermint/v1beta1/blocks/latest");
  return parseInt(response.block.header.height, 10);
}

async function findBlockHeightForDate(date: string): Promise<number> {
  // Target: end of day (23:59:59 UTC) to capture full day including downtime/upgrades
  const targetTime = new Date(date + "T23:59:59.999Z");

  logger.info(`Finding block height for ${date} (${targetTime.toISOString()})`);

  // Bound the interpolation search by the real chain range [1, latest].
  //
  // The previous approach extrapolated a single average block time measured over
  // genesis..50,000 across all of history and then searched a tiny +/-5000-block
  // window around that guess. Osmosis block time is NOT constant over its
  // history, so that average was wildly off for recent dates (it placed
  // mid-2026 near height ~24M when the chain was past ~62M), and the narrow
  // window made the error unrecoverable. interpolationSearchBlockByTimestamp
  // already does correct time-proportional interpolation and converges in a
  // handful of iterations, so we just give it real bounds that bracket the
  // target instead of a pre-guessed window.
  const latestHeight = await fetchLatestHeight();
  const minHeight = 1;
  const maxHeight = latestHeight;

  logger.debug(
    `Searching for ${date} within real chain range ${minHeight}-${maxHeight}`
  );

  const blockHeight = await interpolationSearchBlockByTimestamp(
    targetTime,
    minHeight,
    maxHeight,
    0 // avgBlockTimeMs is unused by the search; interpolation is time-based
  );

  logger.info(`Found block ${blockHeight} for date ${date}`);

  return blockHeight;
}

export async function getBlockHeightForDate(date: string): Promise<number> {
  // Check cache first
  const cache = loadEpochCache();

  if (cache[date]) {
    logger.debug(
      `Using cached block height for ${date}: ${cache[date].blockHeight}`
    );
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
