import { getHistory } from "../lib/historical-file";
import { logger } from "../lib/logger";

// ===================================
// Types
// ===================================

interface ValidationResult {
  totalRecords: number;
  dateRange: { start: string; end: string };
  gaps: string[];
  anomalies: Array<{ date: string; issue: string }>;
  coverage: {
    mintedSupply: number;
    burnedSupply: number;
    inflationRate: number;
    totalStaked: number;
    distributionParams: number;
  };
}

// ===================================
// Validation Logic
// ===================================

async function validateHistory(): Promise<ValidationResult> {
  const history = await getHistory();

  if (history.length === 0) {
    throw new Error("No historical records found");
  }

  const result: ValidationResult = {
    totalRecords: history.length,
    dateRange: {
      start: history[0].timestamp,
      end: history[history.length - 1].timestamp,
    },
    gaps: [],
    anomalies: [],
    coverage: {
      mintedSupply: 0,
      burnedSupply: 0,
      inflationRate: 0,
      totalStaked: 0,
      distributionParams: 0,
    },
  };

  // Check for gaps in dates
  for (let i = 1; i < history.length; i++) {
    const prevDate = new Date(history[i - 1].timestamp);
    const currDate = new Date(history[i].timestamp);
    const daysDiff = Math.ceil(
      (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysDiff > 1) {
      result.gaps.push(
        `Gap of ${daysDiff} days between ${
          prevDate.toISOString().split("T")[0]
        } and ${currDate.toISOString().split("T")[0]}`
      );
    }
  }

  // Check for anomalies
  for (let i = 0; i < history.length; i++) {
    const record = history[i];
    const date = record.timestamp.split("T")[0];

    // Supply should be positive and within range
    if (
      record.totalSupply < 100_000_000 ||
      record.totalSupply > 1_000_000_000
    ) {
      result.anomalies.push({
        date,
        issue: `Total supply out of range: ${record.totalSupply}`,
      });
    }

    // Circulating should be less than total (skip if unset/pending interpolation)
    if (
      record.circulatingSupply !== undefined &&
      record.circulatingSupply > record.totalSupply
    ) {
      result.anomalies.push({
        date,
        issue: "Circulating supply exceeds total supply",
      });
    }

    // Inflation rate should be reasonable. Genesis-era inflation is legitimately
    // high (~88% at launch: ~822k OSMO/day minted against a small early supply),
    // declining via thirdenings. The ceiling allows that real early range and
    // only flags clearly-broken values (negative or absurd).
    if (record.inflationRate < 0 || record.inflationRate > 100) {
      result.anomalies.push({
        date,
        issue: `Inflation rate out of range: ${record.inflationRate}%`,
      });
    }

    // MINTED supply is the real monotonic invariant — minting only ever adds.
    // (totalSupply = minted - burned CAN legitimately decrease on days where the
    // burn delta exceeds the mint delta, so checking totalSupply here would flag
    // genuine burn-driven dips.) Flag only a real decrease in minted supply.
    if (i > 0) {
      const prevMinted = history[i - 1].mintedSupply;
      const mintedDiff = record.mintedSupply - prevMinted;

      if (mintedDiff < -10000) {
        result.anomalies.push({
          date,
          issue: `Minted supply decreased by ${Math.abs(mintedDiff)} OSMO (mint should be monotonic)`,
        });
      }
    }

    // Calculate coverage
    if (record.mintedSupply > 0) result.coverage.mintedSupply++;
    if (record.burnedSupply >= 0) result.coverage.burnedSupply++;
    if (record.inflationRate > 0) result.coverage.inflationRate++;
    if (record.totalStaked) result.coverage.totalStaked++;
    if (record.distributionProportions) result.coverage.distributionParams++;
  }

  // Convert coverage to percentages
  result.coverage.mintedSupply =
    (result.coverage.mintedSupply / history.length) * 100;
  result.coverage.burnedSupply =
    (result.coverage.burnedSupply / history.length) * 100;
  result.coverage.inflationRate =
    (result.coverage.inflationRate / history.length) * 100;
  result.coverage.totalStaked =
    (result.coverage.totalStaked / history.length) * 100;
  result.coverage.distributionParams =
    (result.coverage.distributionParams / history.length) * 100;

  return result;
}

// ===================================
// CLI Entry Point
// ===================================

async function main() {
  try {
    console.log("=".repeat(60));
    console.log("Validating Historical Data");
    console.log("=".repeat(60));

    const result = await validateHistory();

    console.log(`\nTotal Records: ${result.totalRecords}`);
    console.log(
      `Date Range: ${result.dateRange.start.split("T")[0]} to ${
        result.dateRange.end.split("T")[0]
      }`
    );

    console.log("\nCoverage:");
    console.log(`  Minted Supply: ${result.coverage.mintedSupply.toFixed(1)}%`);
    console.log(`  Burned Supply: ${result.coverage.burnedSupply.toFixed(1)}%`);
    console.log(
      `  Inflation Rate: ${result.coverage.inflationRate.toFixed(1)}%`
    );
    console.log(`  Total Staked: ${result.coverage.totalStaked.toFixed(1)}%`);
    console.log(
      `  Distribution Params: ${result.coverage.distributionParams.toFixed(1)}%`
    );

    if (result.gaps.length > 0) {
      console.log(`\n⚠ Date Gaps (${result.gaps.length}):`);
      result.gaps.forEach((gap) => console.log(`  ${gap}`));
    } else {
      console.log("\n✓ No date gaps found");
    }

    if (result.anomalies.length > 0) {
      console.log(`\n⚠ Anomalies (${result.anomalies.length}):`);
      result.anomalies
        .slice(0, 10)
        .forEach((a) => console.log(`  ${a.date}: ${a.issue}`));
      if (result.anomalies.length > 10) {
        console.log(`  ... and ${result.anomalies.length - 10} more`);
      }
    } else {
      console.log("\n✓ No anomalies detected");
    }

    console.log("\n" + "=".repeat(60));

    // Exit with error code if there are issues
    if (result.gaps.length > 0 || result.anomalies.length > 0) {
      console.log("\n⚠ Validation completed with warnings");
      process.exit(1);
    } else {
      console.log("\n✓ Validation passed!");
      process.exit(0);
    }
  } catch (error) {
    console.error("\n✗ Validation failed:", error);
    process.exit(1);
  }
}

main();
