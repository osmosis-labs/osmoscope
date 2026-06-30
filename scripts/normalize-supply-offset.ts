import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { type HistoricalRecord } from "../lib/historical-file";

/**
 * One-time, idempotent migration that normalizes historical OSMO supply so the
 * whole series is consistent with the chain's CURRENT reported supply, and free
 * of backfill artifacts.
 *
 * Two corrections, in order:
 *
 * 1. v27 supply-offset (real, single event).
 *    Osmosis runs a fork of cosmos-sdk x/bank with a "supply offset": a negative
 *    amount subtracted from the reported `by_denom` supply for uosmo, equal to the
 *    (shrinking) unvested developer-vesting module balance, so the unvested dev
 *    allocation is excluded from headline supply. Due to a key-encoding collision
 *    in the v26 cosmos-sdk 0.50 "collections" migration (the offset moved from key
 *    byte 0x88 to NewPrefix(88) == 0x58), the large negative offset stopped being
 *    applied; the v27 upgrade (block 24,250,100, 2024-11-19) reinstated it. The
 *    net observable effect on mainnet: reported `by_denom` supply stepped DOWN by
 *    ~82.97M OSMO on 2024-11-19 and has stayed down since.
 *
 *    Verified against the archive node: by_denom is ~778.03M just before v27
 *    (block 24,240,000) and ~695.06M just after (block 24,260,000), a clean
 *    -82.97M step. Our backfill faithfully recorded the pre-v27 (un-offset) value
 *    for all earlier dates, so every record before 2024-11-19 sits ~82.97M above
 *    the current methodology. We subtract that single offset from those records so
 *    the series is continuous at the current level (no cliff). restrictedSupply is
 *    NOT touched: the offset is the dev-vesting MODULE balance, which we already
 *    measure independently and include in restricted; the offset and our restricted
 *    measurement are the same economic tokens only at the module-balance level, and
 *    the chart's accounting (circulating = total - restricted - community) stays
 *    self-consistent because we recompute circulating from the corrected total.
 *
 *    NOTE on double-counting: pre-v27, total INCLUDED the dev-vesting (offset off)
 *    and restricted ALSO included the dev-vesting module -> circulating was already
 *    correct, but total was ~83M high. Subtracting the offset from total alone now
 *    makes total match the chain while keeping circulating correct ONLY IF we also
 *    keep restricted as-is and recompute circulating. We do exactly that.
 *
 * 2. Backfill artifacts (not real supply events).
 *    A small number of dates carry corrupt `by_denom` reads (archive-node state
 *    inconsistency around the v17 upgrade window, and block-height mapping error)
 *    that show as sharp excursions which recover within days. Two were verified
 *    against the archive node as genuine artifacts (chain was smooth/monotonic
 *    through them) and are repaired by nulling the window and linearly
 *    interpolating between the clean anchors on each side:
 *      - 2022-05-10 .. 2022-05-25  (dip ~474M -> ~464M, recovers to ~477M)
 *      - 2023-08-25 .. 2023-09-04  (v17-window dip ~672M -> ~629M, recovers ~673M)
 *    (The smaller July-2024 high-read excursion is left to the monotonic clamp in
 *    step 3, which absorbs its small downward correction harmlessly; the gentle
 *    Oct-Dec 2023 decline is REAL and intentionally left untouched.)
 *
 * 3. Monotonic clamp (residual jitter).
 *    Block-height interpolation in the backfill leaves pervasive sub-1M day-to-day
 *    jitter, including ~125 days where minted supply spuriously decreases. Real
 *    minting only ever adds, so after the offset and window repairs we clamp the
 *    series to be non-decreasing (minted[i] = max(minted[i], minted[i-1])). This
 *    runs AFTER the v27 offset so the genuine v27 step is already continuous and
 *    is not clamped away. The explicit window repairs run first so the clamp does
 *    not propagate an artifact spike-top forward.
 *
 * circulatingSupply is recomputed from the corrected totalSupply wherever the
 * parts are present. Idempotent via the `supplyOffsetNormalized` marker.
 */

// --- Constants -------------------------------------------------------------

/** Real v27 supply-offset reinstated on 2024-11-19 (OSMO). Measured from the
 *  archive by_denom step 778,026,867.99 -> 695,060,074.83. */
const V27_OFFSET_OSMO = 82_966_793.163_037;

/** First UTC date on which the v27 offset is live on-chain (== upgrade date).
 *  Records on/after DATA_START and strictly before this get the offset subtracted. */
const V27_DATE = "2024-11-19";

/** First date with real backfilled supply. Earlier rows are zero-supply stubs
 *  (genesis..data-start is pruned/unrecoverable) and must NOT be offset/clamped,
 *  else `0 - offset` produces negative garbage. Matches the API's DATA_START_DATE. */
const DATA_START_DATE = "2021-12-15";

/** Verified artifact windows (inclusive). Values inside are dropped and refilled
 *  by linear interpolation between the clean record immediately before the start
 *  and immediately after the end. */
const ARTIFACT_WINDOWS: Array<{ start: string; end: string }> = [
  // End at 05-26 (still depressed) so the clean after-anchor is 05-27 (477.40M);
  // anchoring on 05-26 (473.46M, below the 05-09 start) would interpolate downward.
  { start: "2022-05-10", end: "2022-05-26" },
  { start: "2023-08-25", end: "2023-09-04" },
];

interface RecordWithMarker extends HistoricalRecord {
  supplyOffsetNormalized?: boolean;
}

// --- Helpers ---------------------------------------------------------------

function dateOf(r: HistoricalRecord): string {
  return r.timestamp.split("T")[0];
}

function recomputeCirculating(r: RecordWithMarker): void {
  if (r.restrictedSupply != null && r.communitySupply != null) {
    r.circulatingSupply =
      r.totalSupply - r.restrictedSupply - r.communitySupply;
  }
}

// --- Migration -------------------------------------------------------------

function normalizeFile(file: string, dryRun: boolean): void {
  if (!fs.existsSync(file)) {
    logger.warn(`File not found, skipping: ${file}`);
    return;
  }
  const records: RecordWithMarker[] = JSON.parse(
    fs.readFileSync(file, "utf-8")
  );
  if (records.length === 0) return;

  if (records.every((r) => r.supplyOffsetNormalized)) {
    logger.info(`${path.basename(file)}: already normalized, skipping`);
    return;
  }

  // Work on records that have a usable mintedSupply, in chronological order.
  const sorted = [...records].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // --- Step 1: retroactive v27 offset on real pre-v27 records --------------
  // Only records in [DATA_START_DATE, V27_DATE) carry real un-offset supply;
  // earlier rows are zero-supply stubs and are skipped.
  let offsetApplied = 0;
  for (const r of sorted) {
    if (r.supplyOffsetNormalized) continue;
    const d = dateOf(r);
    if (d >= DATA_START_DATE && d < V27_DATE && r.mintedSupply != null) {
      r.mintedSupply -= V27_OFFSET_OSMO;
      if (r.totalSupply != null) r.totalSupply -= V27_OFFSET_OSMO;
      else r.totalSupply = r.mintedSupply - (r.burnedSupply ?? 0);
      recomputeCirculating(r);
      offsetApplied++;
    }
  }

  const n = sorted.length;

  // --- Step 2: repair verified artifact windows (null + interpolate) -------
  // For each window, the records strictly inside are refilled by linear
  // interpolation (by timestamp) between the clean record immediately before the
  // window start and immediately after the window end.
  let repaired = 0;
  for (const win of ARTIFACT_WINDOWS) {
    // Index of last record before the window, and first record after it.
    let loIdx = -1;
    let hiIdx = -1;
    for (let k = 0; k < n; k++) {
      const d = dateOf(sorted[k]);
      if (d < win.start) loIdx = k;
      if (d > win.end && hiIdx === -1) hiIdx = k;
    }
    if (loIdx < 0 || hiIdx < 0) {
      logger.warn(
        `  artifact window ${win.start}..${win.end}: missing clean anchor, skipping`
      );
      continue;
    }
    const lo = sorted[loIdx];
    const hi = sorted[hiIdx];
    if (lo.mintedSupply == null || hi.mintedSupply == null) continue;
    const tLo = new Date(lo.timestamp).getTime();
    const tHi = new Date(hi.timestamp).getTime();
    for (let k = loIdx + 1; k < hiIdx; k++) {
      const r = sorted[k];
      const frac = (new Date(r.timestamp).getTime() - tLo) / (tHi - tLo);
      r.mintedSupply =
        lo.mintedSupply + (hi.mintedSupply - lo.mintedSupply) * frac;
      r.totalSupply = r.mintedSupply - (r.burnedSupply ?? 0);
      recomputeCirculating(r);
      repaired++;
    }
  }

  // --- Step 2b: repair one-day V-shaped restricted/community artifacts ------
  // The restricted and community backfills occasionally return a single day where
  // a wallet/pool balance read off (near-zero or doubled), producing a sharp
  // one-day spike or dip that recovers the next day (e.g. restricted 2022-10-30
  // -18M and 2024-10-27 -63M; community 2024-10-27 +15M). Staking/total are flat
  // through these, confirming they are bad single-day reads, not real movements.
  // Detect any day whose value differs from BOTH neighbours by more than
  // ONE_DAY_THRESHOLD in the same direction, and replace it with the neighbour
  // average; circulating is then recomputed so the derived series stays consistent.
  const ONE_DAY_THRESHOLD = 3_000_000;
  let restrictedRepaired = 0;
  const repairField = (field: "restrictedSupply" | "communitySupply") => {
    for (let k = 1; k < n - 1; k++) {
      const p = sorted[k - 1][field];
      const c = sorted[k][field];
      const nx = sorted[k + 1][field];
      if (p == null || c == null || nx == null) continue;
      const dipsBelow = p - c > ONE_DAY_THRESHOLD && nx - c > ONE_DAY_THRESHOLD;
      const spikesAbove =
        c - p > ONE_DAY_THRESHOLD && c - nx > ONE_DAY_THRESHOLD;
      if (dipsBelow || spikesAbove) {
        sorted[k][field] = (p + nx) / 2;
        recomputeCirculating(sorted[k]);
        restrictedRepaired++;
      }
    }
  };
  repairField("restrictedSupply");
  repairField("communitySupply");

  // --- Step 3: monotonic clamp for residual downward jitter ----------------
  // Real minting only adds, so minted must be non-decreasing. Runs after the v27
  // offset (so the series is already continuous across v27) and after the window
  // repairs (so no artifact spike-top is propagated forward).
  let clamped = 0;
  let prev = -Infinity;
  for (let k = 0; k < n; k++) {
    const r = sorted[k];
    if (dateOf(r) < DATA_START_DATE || r.mintedSupply == null) continue;
    if (r.mintedSupply < prev) {
      r.mintedSupply = prev;
      r.totalSupply = r.mintedSupply - (r.burnedSupply ?? 0);
      recomputeCirculating(r);
      clamped++;
    }
    prev = r.mintedSupply;
  }

  // --- Mark all as normalized ---------------------------------------------
  for (const r of sorted) r.supplyOffsetNormalized = true;

  logger.info(
    `${path.basename(file)}: v27 offset applied to ${offsetApplied} pre-${V27_DATE} records, ` +
      `${repaired} supply artifact-window day(s) interpolated, ` +
      `${restrictedRepaired} one-day restricted/community artifact(s) repaired, ` +
      `${clamped} day(s) monotonic-clamped`
  );

  if (!dryRun) {
    // Preserve original on-disk order (records array), values mutated in place
    // (sorted holds the same object references).
    fs.writeFileSync(file, JSON.stringify(records, null, 2));
    logger.info(`  ✓ written`);
  } else {
    logger.info(`  (dry run — not written)`);
  }
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const dataDir = path.join(process.cwd(), "data");
  const files = [
    path.join(dataDir, "history.json"),
    path.join(dataDir, "history-archive.json"),
  ];

  logger.info("=".repeat(60));
  logger.info("Normalize supply offset (v27 retroactive) + repair artifacts");
  logger.info(
    `v27 offset: ${(V27_OFFSET_OSMO / 1e6).toFixed(3)}M OSMO, date ${V27_DATE}`
  );
  logger.info(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);
  logger.info("=".repeat(60));

  for (const f of files) normalizeFile(f, dryRun);

  logger.info(
    "\nDone. Re-run is a no-op (idempotent via supplyOffsetNormalized)."
  );
}

main();
