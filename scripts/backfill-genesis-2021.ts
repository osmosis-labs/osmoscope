import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { type HistoricalRecord } from "../lib/historical-file";

/**
 * One-time, idempotent backfill for the genesis..data-start gap (2021-06-19 ..
 * 2021-12-14). The chain state for this window is pruned and unrecoverable from
 * the archive node, so supply is reconstructed deterministically from known
 * anchors rather than queried.
 *
 * Model (confirmed with the team and cross-checked against the archive where
 * possible):
 *  - Genesis (2021-06-19): total = 325M = 275M restricted (developer-vesting +
 *    strategic reserve) + 50M airdrop (circulating). Community pool = 0.
 *  - First real record (2021-12-15): total 352.375M, restricted 253.99M,
 *    community 40.87M, circulating 57.52M (queried from chain, already present).
 *
 * Per-component reconstruction across the 179-day gap:
 *  - communitySupply: KEEP the existing stub values, which are accurate (verified
 *    against the archive: steady accrual ~0.82M Jun -> ~8.58M Dec 14, the normal
 *    emission-share fill). The pool then steps to 40.87M via a ONE-TIME +32.24M
 *    deposit at block 2,397,435 on 2021-12-15T17:00:03 UTC: the genesis airdrop
 *    clawback. The x/claim module EndBlocker fires EndAirdrop exactly once when
 *    BlockTime exceeds AirdropStartTime + DurationUntilDecay(2mo) + DurationOf-
 *    Decay(4mo) = ~6 months after the Jun-2021 launch, sweeping the claim module's
 *    residual balance (unclaimed / decayed-forfeit airdrop) into the community
 *    pool via distrKeeper.FundCommunityPool (osmosis v4.0.0 x/claim/keeper/claim.go;
 *    intent ratified by gov Proposal #32). It is a real same-day event, so it lives
 *    on the first real record, not smeared backward. Circulating therefore steps
 *    DOWN ~32M on 2021-12-15 — faithful to the chain, not an artifact.
 *  - totalSupply: linear interpolation 325M -> 352.375M by timestamp. Genesis
 *    emissions were near-linear day to day; we do not have per-epoch provisions
 *    for the pruned window, so a straight line between the two known totals is
 *    the least-assumption fit (+27.375M over 179 days).
 *  - restrictedSupply: linear interpolation 275M -> 253.99M by timestamp
 *    (developer-vesting + strategic reserve vesting/unlocking down).
 *  - circulatingSupply: DERIVED = total - restricted - community, so the
 *    accounting identity holds every day and the 50M airdrop is implicit in the
 *    genesis circulating (325 - 275 - 0 = 50).
 *  - inflationRate: provisions are the constant genesis value through 2021 (first
 *    thirdening ~2 years out), so reported inflation declines purely as supply
 *    grows. We interpolate the annual-provision basis (inflation * supply) from
 *    GENESIS_INFLATION to the first real reported value, then divide by supply
 *    (~66.8% at genesis -> ~65.5% on 2021-12-15).
 *
 * burnedSupply stays 0 (the burn address received nothing in 2021). totalStaked
 * and distributionProportions in the stubs are already real and left untouched.
 *
 * Marked `genesisBackfilled: true` for idempotency. These rows predate the API's
 * DATA_START_DATE (2021-12-15) gate, so they are reconstructed for completeness
 * but only surface if that gate is moved earlier.
 */

// --- Anchors ---------------------------------------------------------------

const GENESIS_DATE = "2021-06-19";
const FIRST_REAL_DATE = "2021-12-15";

const GENESIS_TOTAL = 325_000_000;
const GENESIS_RESTRICTED = 275_000_000;

// Genesis annualized inflation (%). Provisions are the constant genesis value
// (~821,918 OSMO/day) through 2021 since the first thirdening is ~2 years out, so
// the chain's reported inflation declines purely as supply grows. The early real
// data's annual-provision basis (inflation * supply) trends ~linearly; back-
// projecting it to genesis gives ~66.8% at a 325M supply. We anchor the curve here
// and on the first real reported value (~65.5% on 2021-12-15).
const GENESIS_INFLATION = 66.8;

// First real record values (the after-anchor). Read from data at run time to stay
// in sync, with these as the documented expectation.
const EXPECTED_FIRST_REAL_TOTAL = 352_375_000;
const EXPECTED_FIRST_REAL_RESTRICTED = 253_990_000;

interface RecordWithMarkers extends HistoricalRecord {
  genesisBackfilled?: boolean;
  supplyOffsetNormalized?: boolean;
}

function dateOf(r: HistoricalRecord): string {
  return r.timestamp.split("T")[0];
}

function t(dateStr: string): number {
  return new Date(`${dateStr}T17:20:00.000Z`).getTime();
}

function lerp(a: number, b: number, frac: number): number {
  return a + (b - a) * frac;
}

function backfillFile(file: string, dryRun: boolean): void {
  if (!fs.existsSync(file)) {
    logger.warn(`File not found, skipping: ${file}`);
    return;
  }
  const records: RecordWithMarkers[] = JSON.parse(
    fs.readFileSync(file, "utf-8")
  );

  // The after-anchor: first real record (>= FIRST_REAL_DATE, real supply).
  const firstReal = records
    .filter((r) => dateOf(r) >= FIRST_REAL_DATE && (r.mintedSupply ?? 0) > 1e6)
    .sort((a, b) => t(dateOf(a)) - t(dateOf(b)))[0];
  if (!firstReal) {
    logger.warn(`${path.basename(file)}: no first-real anchor found, skipping`);
    return;
  }
  const afterTotal = firstReal.totalSupply;
  const afterRestricted =
    firstReal.restrictedSupply ?? EXPECTED_FIRST_REAL_RESTRICTED;

  // Sanity: warn if the anchor drifted from the documented expectation.
  if (Math.abs(afterTotal - EXPECTED_FIRST_REAL_TOTAL) > 5_000_000) {
    logger.warn(
      `  first-real total ${(afterTotal / 1e6).toFixed(2)}M differs from expected ` +
        `${(EXPECTED_FIRST_REAL_TOTAL / 1e6).toFixed(2)}M; using actual.`
    );
  }

  const tG = t(GENESIS_DATE);
  const tA = t(FIRST_REAL_DATE);
  const span = tA - tG;

  // Inflation: provisions are the constant genesis value through 2021 (first
  // thirdening is ~2 years out), so the chain's reported inflation declines
  // smoothly as supply grows. We anchor on the first real reported value and
  // interpolate the genesis value back along the annual-provision basis
  // (inflation * supply), which the early real data shows trending roughly
  // linearly. GENESIS_INFLATION is the back-projection of that basis to genesis.
  const afterInflation = firstReal.inflationRate ?? 0;

  let filled = 0;
  for (const r of records) {
    const d = dateOf(r);
    if (d < GENESIS_DATE || d >= FIRST_REAL_DATE) continue;
    if (r.genesisBackfilled) continue;

    const frac = (t(d) - tG) / span;
    const total = lerp(GENESIS_TOTAL, afterTotal, frac);
    const restricted = lerp(GENESIS_RESTRICTED, afterRestricted, frac);

    // Community: KEEP the real stub value (verified against the archive: steady
    // accrual ~0 -> ~8.58M from genesis to Dec 14). The jump to 40.87M is the
    // one-time airdrop-clawback deposit on 2021-12-15 (the chain really stepped
    // the pool up that day), which belongs to the first real record, NOT smeared
    // backward. Circulating therefore steps down on Dec 15 — a faithful event.
    const community = r.communitySupply ?? 0;

    // Inflation: interpolate the annual-provision basis (inflation * supply) from
    // its genesis value to the first-real basis, then divide by supply. This keeps
    // the genesis curve consistent with the chain's reported decline.
    const genesisBasis = (GENESIS_INFLATION / 100) * GENESIS_TOTAL;
    const afterBasis = (afterInflation / 100) * afterTotal;
    const basis = lerp(genesisBasis, afterBasis, frac);
    // total is always >= GENESIS_TOTAL (325M) in this window, so this is finite.
    const inflationRate = (basis / total) * 100;

    r.mintedSupply = total; // burned is 0 in this window, so minted == total
    r.burnedSupply = 0;
    r.totalSupply = total;
    r.restrictedSupply = restricted;
    r.communitySupply = community;
    r.circulatingSupply = total - restricted - community;
    r.inflationRate = inflationRate;
    r.genesisBackfilled = true;
    // Already-normalized series: mark so the offset migration treats these as done
    // (the v27 offset must NOT be applied to genesis-era reconstructed values).
    r.supplyOffsetNormalized = true;
    filled++;
  }

  logger.info(
    `${path.basename(file)}: ${filled} genesis-era record(s) reconstructed ` +
      `(${GENESIS_DATE} .. ${FIRST_REAL_DATE}, total ${(GENESIS_TOTAL / 1e6).toFixed(0)}M -> ${(afterTotal / 1e6).toFixed(2)}M)`
  );

  if (!dryRun) {
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
  logger.info("Backfill genesis 2021 supply (deterministic reconstruction)");
  logger.info(
    `Genesis ${GENESIS_DATE}: ${(GENESIS_TOTAL / 1e6).toFixed(0)}M total ` +
      `(${(GENESIS_RESTRICTED / 1e6).toFixed(0)}M restricted + 50M airdrop)`
  );
  logger.info(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);
  logger.info("=".repeat(60));

  for (const f of files) backfillFile(f, dryRun);

  logger.info("\nDone. Idempotent via genesisBackfilled marker.");
}

main();
