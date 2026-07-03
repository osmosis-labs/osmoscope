import fs from "fs";
import path from "path";
import { logger } from "../../lib/logger";

// Archive node configuration
const ARCHIVE_NODE_URL = "https://lcd.archive.osmosis.zone";
// Global min spacing between requests. fetchLockedBalances now bounds concurrency
// itself (CONCURRENCY workers), so the per-date cost was dominated by this global
// throttle (18 addresses x 667ms ~= 12s). Raised to 5 req/s (~200ms spacing) to
// cut that ~3x while staying polite to the archive node; if Cloudflare rate-limit
// (429) / challenge responses reappear, the retry/backoff in queryArchiveNode
// handles them and this can be dialed back.
const REQUESTS_PER_SECOND = 5;
const DELAY_MS = 1000 / REQUESTS_PER_SECOND; // 200ms between requests

// Pruned-node fallback for RECENT heights the archive node cannot serve.
//
// The archive node is currently stuck at a frozen tip, so heights above that tip
// (the recent ~month) 404 there. cosmos.directory is a load balancer that
// rotates across many community nodes; collectively they retain a deep-enough
// recent window to cover that gap. Individual nodes prune at different depths, so
// a single request may hit a node that pruned the target height — but because
// the balancer rotates per request, simply re-requesting the same height usually
// lands on a node that has it. PRUNED_FALLBACK_RETRIES bounds that re-roll.
const PRUNED_FALLBACK_URL = "https://rest.cosmos.directory/osmosis";
// ~30% of rotated nodes lag a given recent height; 12 rerolls puts the
// per-height failure probability near zero across a multi-hundred-height gap.
const PRUNED_FALLBACK_RETRIES = 12;

// Main (current) LCD, used only for the chain TIP and block-header lookups.
// State queries go through the archive node (with pruned fallback); blocks and
// headers are widely available and we need the REAL tip (not the archive node's
// frozen one) so date->height interpolation can reach recent dates.
const MAIN_LCD_URL = "https://lcd.osmosis.zone";

// The archive node's frozen tip. For any height AT OR BELOW this, the archive
// node is the source of truth and a failure is transient (retry the archive) —
// we must NOT fall back to cosmos.directory there, because its pruned/current
// nodes can silently return CURRENT state for a historical height (verified:
// a 2021 height returned today's supply). The pruned fallback is ONLY safe for
// heights ABOVE this tip (the recent gap), where any served value is genuinely
// recent. This is set lazily from the archive's reported tip on first use.
let archiveTipHeight: number | null = null;
const ARCHIVE_TIP_FALLBACK = 62_655_964; // last known frozen tip (2026-05-27)

async function getArchiveTip(): Promise<number> {
  if (archiveTipHeight !== null) return archiveTipHeight;
  try {
    const r = await fetch(
      `${ARCHIVE_NODE_URL}/cosmos/base/tendermint/v1beta1/blocks/latest`,
      { headers: { Accept: "application/json" } }
    );
    const j = (await r.json()) as { block: { header: { height: string } } };
    archiveTipHeight = parseInt(j.block.header.height, 10);
  } catch {
    archiveTipHeight = ARCHIVE_TIP_FALLBACK;
  }
  return archiveTipHeight;
}

// True only for heights ABOVE the archive's tip (the recent gap), where the
// pruned-node fallback is safe to use.
async function isHeightInRecentGap(height: number): Promise<boolean> {
  return height > (await getArchiveTip());
}

// Substrings that indicate a node does not have state at the requested height
// (pruned or beyond its tip), as opposed to a transient/transport error.
function isPrunedOrMissingHeight(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("pruned") ||
    m.includes("no commit info") ||
    m.includes("lowest height") ||
    m.includes("is not available") ||
    m.includes("bigger then the chain length") ||
    m.includes("failed to load state at height") ||
    m.includes("version does not exist") || // IAVL: node lags this height
    m.includes("height in the future") // archive's frozen tip sees gap as future
  );
}

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
  height?: number,
  // Optional historical-response validator, forwarded to the pruned fallback so
  // header-ignoring nodes (that serve current state) are rejected and re-rolled.
  accept?: (json: T) => boolean
): Promise<T> {
  const url = `${ARCHIVE_NODE_URL}${endpoint}`;

  // Use x-cosmos-block-height header instead of query parameter for historical queries
  const headers: Record<string, string> = {};
  if (height) {
    headers["x-cosmos-block-height"] = height.toString();
  }

  logger.debug(`Querying: ${endpoint}${height ? ` at height ${height}` : ""}`);

  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await throttledFetch(url, { headers });

      // Rate limited or transient server/edge errors (502/503/521/522/523/524
      // from Cloudflare when the archive node is briefly unreachable or
      // overloaded). These are NOT a data problem — back off and retry rather
      // than failing the date. On the last attempt, fall through to the
      // pruned-node fallback (a healthy rotated node can usually serve it).
      const transient =
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        (response.status >= 520 && response.status <= 524);
      if (transient) {
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          logger.warn(
            `Archive node ${response.status} (transient), backing off ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`
          );
          await sleep(backoffMs);
          continue;
        }
        if (height && (await isHeightInRecentGap(height))) {
          logger.warn(
            `Archive node ${response.status} persisted; using pruned fallback for gap height ${height}`
          );
          return await queryPrunedFallback<T>(endpoint, height, accept);
        }
        throw new Error(
          `HTTP ${response.status} after ${MAX_ATTEMPTS} attempts`
        );
      }

      // The archive node sits behind Cloudflare, which can return an HTTP 200
      // "Just a moment..." interstitial (HTML, not JSON) under load. Detect it
      // by content type and back off + retry rather than crashing on JSON.parse.
      const contentType = response.headers.get("content-type") || "";

      if (!response.ok) {
        const body = await response.text();
        // Height beyond the archive's frozen tip (the recent gap): route to the
        // rotating pruned-node fallback. Gated to gap heights ONLY — for heights
        // the archive should have, the fallback is unsafe (it can return current
        // state for a historical height), so we surface the error to retry the
        // archive instead.
        if (
          height &&
          isPrunedOrMissingHeight(body) &&
          (await isHeightInRecentGap(height))
        ) {
          logger.debug(
            `Archive node missing gap height ${height}; using pruned fallback`
          );
          return await queryPrunedFallback<T>(endpoint, height, accept);
        }
        // The staking delegations endpoint returns 500 "invalid denom" across a
        // 2023 SDK upgrade boundary where this archive node's current binary
        // can't decode the old-format state. Do NOT route to the cosmos.directory
        // rotation here: verified that the nodes which respond for these heights
        // ignore the height header and return CURRENT staked (~61M) instead of the
        // 2023 value (~50M) — i.e. a silent wrong-era lie. Mark non-retryable so
        // the caller leaves the value unset and it gets honestly interpolated
        // between real neighbours rather than corrupted with current-state data.
        if (response.status === 500 && body.includes("invalid denom")) {
          const e = new Error(
            `Non-retryable: invalid denom at height ${height}`
          );
          (e as { nonRetryable?: boolean }).nonRetryable = true;
          throw e;
        }
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 120)}`);
      }

      if (!contentType.includes("application/json")) {
        if (attempt < MAX_ATTEMPTS) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          logger.warn(
            `Non-JSON response (likely Cloudflare challenge), backing off ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`
          );
          await sleep(backoffMs);
          continue;
        }
        if (height && (await isHeightInRecentGap(height))) {
          logger.warn(
            `Cloudflare challenge persisted; using pruned fallback for gap height ${height}`
          );
          return await queryPrunedFallback<T>(endpoint, height, accept);
        }
        throw new Error(`Non-JSON response after ${MAX_ATTEMPTS} attempts`);
      }

      const body = await response.text();
      const json = JSON.parse(body);
      // Some Cosmos LCDs return HTTP 200 with an error envelope for a missing
      // height; route those to the fallback too.
      if (
        height &&
        json &&
        typeof json.message === "string" &&
        json.code &&
        isPrunedOrMissingHeight(json.message) &&
        (await isHeightInRecentGap(height))
      ) {
        logger.debug(
          `Archive node missing-height envelope for gap height ${height}; using pruned fallback`
        );
        return await queryPrunedFallback<T>(endpoint, height, accept);
      }
      return json as T;
    } catch (error: unknown) {
      // Deterministic, non-retryable errors (e.g. "invalid denom" decode failure
      // at an upgrade-boundary height): surface immediately so the caller skips
      // the height fast instead of burning the full retry budget.
      if ((error as { nonRetryable?: boolean })?.nonRetryable) throw error;
      // Network-level exception (DNS, connection reset, JSON parse on a
      // truncated body). Retry with backoff; on the last attempt fall back to a
      // rotated node if we have a height, otherwise surface the error.
      if (attempt < MAX_ATTEMPTS) {
        logger.warn(
          `Attempt ${attempt}/${MAX_ATTEMPTS} failed (${error instanceof Error ? error.message.slice(0, 80) : "error"}), retrying...`
        );
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      if (height && (await isHeightInRecentGap(height))) {
        logger.warn(
          `Archive query errored ${MAX_ATTEMPTS}x; using pruned fallback for gap height ${height}`
        );
        try {
          return await queryPrunedFallback<T>(endpoint, height, accept);
        } catch (_fbErr: unknown) {
          // fall through to throw the original error
        }
      }
      logger.error(`Failed after ${MAX_ATTEMPTS} attempts: ${url}`, error);
      throw error;
    }
  }

  throw new Error("Unreachable");
}

// Query a height the archive node cannot serve, via the rotating pruned-node
// fallback. Re-requests the SAME height (each request hits a freshly rotated
// node) until one has the state or the retry budget is exhausted. A pruned-miss
// is retried; a transport error is retried with a short backoff. Throws if no
// node in the rotation can serve the height within the budget.
// `accept` (optional) validates that a JSON response is genuinely historical.
// Some rotated nodes IGNORE the x-cosmos-block-height header and return CURRENT
// state (verified: they serve today's balance for a past height). Such a
// response is well-formed JSON and would otherwise be accepted silently,
// corrupting the backfill (e.g. burn stamped with today's value for a past day,
// producing a non-monotonic series). When `accept` returns false, we treat the
// response as a header-ignoring node and re-roll onto another node, exactly as
// we do for a pruned miss. Callers that can't distinguish current-vs-historical
// omit `accept` and get the prior behavior.
async function queryPrunedFallback<T>(
  endpoint: string,
  height: number,
  accept?: (json: T) => boolean
): Promise<T> {
  const url = `${PRUNED_FALLBACK_URL}${endpoint}`;
  const headers: Record<string, string> = {
    "x-cosmos-block-height": height.toString(),
  };

  let lastErr = "";
  for (let attempt = 1; attempt <= PRUNED_FALLBACK_RETRIES; attempt++) {
    try {
      const response = await throttledFetch(url, { headers });

      if (response.status === 429) {
        await sleep(Math.pow(2, attempt) * 500);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      const body = await response.text();

      if (!response.ok || !contentType.includes("application/json")) {
        lastErr = `HTTP ${response.status}: ${body.slice(0, 120)}`;
        // Pruned/missing-height on this rotated node: re-roll immediately onto
        // another node. Other failures: brief backoff then re-roll.
        if (!isPrunedOrMissingHeight(body)) await sleep(500);
        continue;
      }

      const json = JSON.parse(body);
      // Some nodes return 200 with an error envelope; treat pruned envelopes as
      // a miss and re-roll.
      if (json && typeof json.message === "string" && json.code) {
        lastErr = json.message;
        if (!isPrunedOrMissingHeight(json.message)) await sleep(500);
        continue;
      }
      // Reject a node that ignored the height header and served current state.
      if (accept && !accept(json as T)) {
        lastErr = `node likely ignored height ${height} (served current state)`;
        continue; // re-roll immediately onto another node
      }
      logger.debug(
        `Pruned-fallback served height ${height} on attempt ${attempt}`
      );
      return json as T;
    } catch (error: unknown) {
      lastErr = error instanceof Error ? error.message : String(error);
      await sleep(500);
    }
  }

  throw new Error(
    `Pruned-fallback exhausted ${PRUNED_FALLBACK_RETRIES} rerolls for ${endpoint} at height ${height}: ${lastErr}`
  );
}

/**
 * Query archive node with fallback to nearby blocks
 * If the target height fails, tries nearby blocks (±10, ±100, ±500) as approximation
 * Returns both the data and the actual height used (for pagination support)
 */
export async function queryArchiveNodeWithFallbackAndHeight<T>(
  endpoint: string,
  targetDate: string,
  targetHeight: number,
  accept?: (json: T) => boolean
): Promise<{ data: T; height: number } | null> {
  // Try target height first
  try {
    const data = await queryArchiveNode<T>(endpoint, targetHeight, accept);
    return { data, height: targetHeight };
  } catch (error: unknown) {
    // Deterministic decode errors ("invalid denom" upgrade window) will fail at
    // every nearby block too — propagate immediately so the caller can flag the
    // height as unavailable rather than slowly trying neighbours that also 500.
    if ((error as { nonRetryable?: boolean })?.nonRetryable) throw error;
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
      const data = await queryArchiveNode<T>(endpoint, earlierHeight, accept);
      return { data, height: earlierHeight };
    } catch (_error: unknown) {
      logger.warn(`  Block -${offset} failed`);
    }

    // Try later blocks
    try {
      const laterHeight = targetHeight + offset;
      logger.info(`  Trying ${offset} blocks later: ${laterHeight}`);
      const data = await queryArchiveNode<T>(endpoint, laterHeight, accept);
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
  targetHeight: number,
  // Optional historical-response validator (see queryPrunedFallback). Lets
  // balance fetchers reject a rotated node that ignored the height header and
  // served current state, forcing a re-roll to a header-honoring node.
  accept?: (json: T) => boolean
): Promise<T | null> {
  const result = await queryArchiveNodeWithFallbackAndHeight<T>(
    endpoint,
    targetDate,
    targetHeight,
    accept
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

// Fetch a single block header by height. Blocks (unlike state) are not
// state-pruned the same way: the archive node has all OLD blocks, and the main
// LCD has all RECENT blocks. We try the archive node first, then the main LCD,
// so headers resolve across the whole range including the recent gap the archive
// node's frozen tip cannot serve. Returns null if neither source has it.
async function fetchBlockHeaderAt(height: number): Promise<BlockHeader | null> {
  const path = `/cosmos/base/tendermint/v1beta1/blocks/${height}`;
  // Archive node (good for old heights). Skip it for heights ABOVE the archive's
  // frozen tip: it would 400 ("bigger than chain length") and burn the full
  // retry budget on every interpolation that probes a high boundary. For those,
  // go straight to the main LCD.
  const aboveArchiveTip = height > (await getArchiveTip());
  if (!aboveArchiveTip) {
    try {
      const r = await queryArchiveNode<{ block: { header: BlockHeader } }>(
        path
      );
      return r.block.header;
    } catch (_e: unknown) {
      // fall through to main LCD
    }
  }
  // Main LCD (good for recent heights, but it block-prunes below a recent floor).
  try {
    const resp = await fetch(`${MAIN_LCD_URL}${path}`, {
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      const j = (await resp.json()) as { block?: { header?: BlockHeader } };
      if (j.block?.header) return j.block.header;
    }
  } catch (_e: unknown) {
    // fall through to pruned fallback
  }
  // Pruned-node fallback (cosmos.directory rotation) for heights in the gap that
  // sit below the main LCD's block-retention floor and above the archive's
  // frozen tip. Block fetches don't take the height header; the rotation itself
  // finds a node deep enough to have the block.
  try {
    const r = await queryPrunedFallback<{ block: { header: BlockHeader } }>(
      path,
      height
    );
    if (r.block?.header) return r.block.header;
  } catch (_e: unknown) {
    // give up below
  }
  return null;
}

async function queryBlockHeader(height: number): Promise<BlockHeader> {
  // Try the exact height first, then nearby blocks as a fallback for any single
  // missing block. Each lookup tries archive node then main LCD.
  const exact = await fetchBlockHeaderAt(height);
  if (exact) return exact;
  logger.warn(`Failed to query block ${height}, trying nearby blocks...`);

  const offsets = [1, 5, 10, 50];
  for (const offset of offsets) {
    if (height - offset > 0) {
      const earlier = await fetchBlockHeaderAt(height - offset);
      if (earlier) return earlier;
    }
    const later = await fetchBlockHeaderAt(height + offset);
    if (later) return later;
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
  // The full chain range (genesis .. tip ~62M blocks) needs ~26 interpolation
  // steps to converge to within the 600s window; 20 was too few and some dates
  // exited early (returning a stale bound). 32 leaves comfortable headroom.
  const MAX_ITERATIONS = 32;

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

  // Loop exhausted without landing inside the window. The search invariant keeps
  // `high` as the largest block bound at/just-after the target, so `high` is the
  // best "last block <= target" estimate (within a few minutes). Prefer it over
  // the `result` accumulator, which can lag at minHeight when every probed guess
  // fell after the target (search approached purely from above). Clamp to the
  // valid range as a safety net.
  const best = Math.max(minHeight, Math.min(high, maxHeight));
  logger.warn(
    `Search reached max iterations (${MAX_ITERATIONS}); returning best bound ${best} (result acc=${result})`
  );
  return best;
}

/**
 * Fetch the current chain tip height from the MAIN LCD.
 *
 * Must use the main LCD, not the archive node: the archive node is stuck at a
 * frozen tip, so using it here would cap the interpolation upper bound below the
 * real chain head and make recent dates unreachable.
 */
async function fetchLatestHeight(): Promise<number> {
  const response = await fetch(
    `${MAIN_LCD_URL}/cosmos/base/tendermint/v1beta1/blocks/latest`,
    { headers: { Accept: "application/json" } }
  );
  const json = (await response.json()) as { block: { header: BlockHeader } };
  return parseInt(json.block.header.height, 10);
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
