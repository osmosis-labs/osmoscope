import fs from "fs";
import path from "path";
import { logger } from "../lib/logger";
import { type HistoricalRecord } from "../lib/historical-file";

/**
 * One-time, idempotent recomputation of the historical inflation rate from the
 * chain's mint-keeper definition, using our normalized total-supply series.
 *
 * Formula (Osmosis x/mint GetInflation, verified verbatim against source at
 * x/mint/keeper/keeper.go in osmosis-labs/osmosis v31):
 *
 *   inflation% = epochProvisions * (1 - communityPoolProportion) * 365
 *                / GetSupplyWithOffset(uosmo) * 100
 *
 * Denominator note: GetSupplyWithOffset is the offset-adjusted MINTED supply, and
 * it does NOT subtract burned tokens. In our schema that is `mintedSupply` (after
 * normalize-supply-offset applied the v27 offset), NOT `totalSupply` (which is
 * mintedSupply - burnedSupply). Cross-checked against the live chain endpoint:
 * with mintedSupply (~779.2M, == chain by_denom 779.3M) the formula yields 1.882%,
 * exactly matching /osmosis/mint/v1beta1/inflation. Using totalSupply (burn
 * subtracted) overstates it by ~0.06pp. So we divide by mintedSupply.
 *
 * The community-pool share is the ONLY proportion excluded; staking, pool-
 * incentives, and developer-rewards are all counted (factor is 1 - community).
 * epochProvisions is the per-day mint, stepping down at each thirdening;
 * communityPoolProportion steps at each governance change to the mint params.
 * Both schedules below were read from the archive node (epoch_provisions and mint
 * params at historical heights, with the step dates bisected).
 *
 * Why recompute rather than keep the stored values: the chain's GetInflation
 * endpoint was only added ~2025-09 (PR #9526), so the HISTORICAL stored values
 * (2021-2022) came from a third-party calc using full provisions over RAW supply,
 * inconsistent with the offset-adjusted minted supply we now chart. Recomputing
 * from the canonical formula and our clean supply makes the whole series internally
 * consistent. The genesis period is therefore correctly STEEP (~88% at genesis,
 * since ~822k OSMO/day is a large fraction of the small early supply).
 *
 * Idempotent via the `inflationRecomputed` marker.
 */

// --- Schedules (from archive; step dates bisected) -------------------------

/** Epoch (daily) provisions in OSMO, effective from each date (UTC). Thirdenings. */
const PROVISIONS_SCHEDULE: Array<{ from: string; provisions: number }> = [
  { from: "2021-06-19", provisions: 821_917.808219 },
  { from: "2022-06-20", provisions: 547_945.205479 },
  { from: "2023-06-21", provisions: 182_648.401826 },
  { from: "2025-06-20", provisions: 121_765.601218 },
];

/** Community-pool distribution proportion, effective from each date (UTC).
 *  Each change is a governance proposal to the mint module params. */
const COMMUNITY_POOL_SCHEDULE: Array<{ from: string; communityPool: number }> =
  [
    { from: "2021-06-19", communityPool: 0.05 },
    // 2023-08 raised staking 0.25->0.50 but left community at 0.05 (no change here).
    { from: "2025-07-17", communityPool: 0.5 },
    { from: "2025-12-06", communityPool: 0.67 },
  ];

const EPOCHS_PER_YEAR = 365;

interface RecordWithMarker extends HistoricalRecord {
  inflationRecomputed?: boolean;
}

function dateOf(r: HistoricalRecord): string {
  return r.timestamp.split("T")[0];
}

function pickForDate<T>(
  schedule: Array<{ from: string } & T>,
  dateStr: string,
  key: keyof T
): number {
  let value = schedule[0][key] as unknown as number;
  for (const entry of schedule) {
    if (dateStr >= entry.from) value = entry[key] as unknown as number;
  }
  return value;
}

function recomputeFile(file: string, dryRun: boolean): void {
  if (!fs.existsSync(file)) {
    logger.warn(`File not found, skipping: ${file}`);
    return;
  }
  const records: RecordWithMarker[] = JSON.parse(
    fs.readFileSync(file, "utf-8")
  );
  if (records.length === 0) return;

  if (records.every((r) => r.inflationRecomputed)) {
    logger.info(
      `${path.basename(file)}: inflation already recomputed, skipping`
    );
    return;
  }

  let updated = 0;
  for (const r of records) {
    if (r.inflationRecomputed) continue;
    // Denominator is GetSupplyWithOffset == our offset-adjusted mintedSupply
    // (NOT totalSupply, which also subtracts burn).
    if (r.mintedSupply == null || r.mintedSupply <= 0) continue;

    const d = dateOf(r);
    const provisions = pickForDate(PROVISIONS_SCHEDULE, d, "provisions");
    const communityPool = pickForDate(
      COMMUNITY_POOL_SCHEDULE,
      d,
      "communityPool"
    );

    r.inflationRate =
      ((provisions * (1 - communityPool) * EPOCHS_PER_YEAR) / r.mintedSupply) *
      100;
    r.inflationRecomputed = true;
    updated++;
  }

  // Sample for the log.
  const byDate: Record<string, RecordWithMarker> = {};
  records.forEach((r) => (byDate[dateOf(r)] = r));
  const sampleDates = ["2021-06-19", "2022-06-01", "2024-06-01", "2026-06-01"];
  const samples = sampleDates
    .map((d) =>
      byDate[d] ? `${d}=${byDate[d].inflationRate.toFixed(1)}%` : null
    )
    .filter(Boolean)
    .join(", ");

  logger.info(
    `${path.basename(file)}: recomputed inflation on ${updated} record(s). ${samples}`
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
  logger.info("Recompute inflation (mint GetInflation, clean supply basis)");
  logger.info(
    "inflation = epochProvisions * (1 - communityPool) * 365 / supply"
  );
  logger.info(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);
  logger.info("=".repeat(60));

  for (const f of files) recomputeFile(f, dryRun);

  logger.info("\nDone. Idempotent via inflationRecomputed marker.");
}

main();
