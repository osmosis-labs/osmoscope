import fs from "fs/promises";
import path from "path";
import type { HistoricalRecord } from "../lib/historical-file";
import { logger } from "../lib/logger";

const HISTORY_FILE = path.join(process.cwd(), "data", "history.json");

// Historical parameter changes
const PARAM_CHANGES = [
  {
    date: new Date("2025-07-09T00:00:00.000Z"),
    changes: {
      poolIncentives: "0.000000000000000000", // Changed from 20% to 0%
      osmoTakerFeeDistribution: {
        stakingRewards: "0.300000000000000000", // Changed from 50% to 30%
        communityPool: "0.000000000000000000",
        burn: "0.700000000000000000", // Changed from 50% to 70%
      },
    },
  },
  {
    date: new Date("2025-07-16T00:00:00.000Z"),
    changes: {
      staking: "0.250000000000000000", // Changed from 50% to 25%
    },
  },
  {
    date: new Date("2025-08-19T00:00:00.000Z"),
    changes: {
      staking: "0.080000000000000000", // Changed from 25% to 8%
    },
  },
  {
    date: new Date("2025-11-03T00:00:00.000Z"),
    changes: {
      nonOsmoTakerFeeDistribution: {
        stakingRewards: "0.225000000000000000", // Changed from 45% to 22.5%
        communityPool: "0.250000000000000000", // Changed from 55% to 25%
        burn: "0.525000000000000000", // Changed from 0% to 52.5%
      },
    },
  },
];

// Initial values (before any changes)
const INITIAL_VALUES = {
  staking: "0.500000000000000000", // 50%
  poolIncentives: "0.200000000000000000", // 20%
  developerRewards: "0.250000000000000000", // 25% (constant)
  communityPool: "0.050000000000000000", // 5% (calculated from others)
  osmoTakerFeeDistribution: {
    stakingRewards: "0.500000000000000000", // 50%
    communityPool: "0.000000000000000000", // 0%
    burn: "0.500000000000000000", // 50%
  },
  nonOsmoTakerFeeDistribution: {
    stakingRewards: "0.450000000000000000", // 45%
    communityPool: "0.550000000000000000", // 55%
    burn: "0.000000000000000000", // 0%
  },
};

function calculateCommunityPool(
  staking: string,
  poolIncentives: string,
  developerRewards: string
): string {
  const stakingNum = parseFloat(staking);
  const poolIncentivesNum = parseFloat(poolIncentives);
  const developerRewardsNum = parseFloat(developerRewards);
  const communityPoolNum =
    1.0 - stakingNum - poolIncentivesNum - developerRewardsNum;
  return communityPoolNum.toFixed(18);
}

async function applyHistoricalParams() {
  try {
    logger.info("Reading history.json...");
    const content = await fs.readFile(HISTORY_FILE, "utf-8");
    const history: HistoricalRecord[] = JSON.parse(content);

    logger.info(`Found ${history.length} historical records`);

    // Current parameter state as we iterate through time
    const currentParams = { ...INITIAL_VALUES };

    // Track circulating proportion to adjust inflation rates
    let currentCirculatingProportion =
      parseFloat(INITIAL_VALUES.staking) +
      parseFloat(INITIAL_VALUES.poolIncentives) +
      parseFloat(INITIAL_VALUES.developerRewards);

    // Date before which we apply the 50% increase
    const HISTORICAL_INFLATION_CUTOFF = new Date("2025-06-21T00:00:00.000Z");

    let updatedCount = 0;
    let prevDate: Date | null = null;

    for (const record of history) {
      const recordDate = new Date(record.timestamp);

      // Check if any parameter changes should be applied for this date
      for (const paramChange of PARAM_CHANGES) {
        // Only apply changes once when we cross the date boundary
        if (
          recordDate >= paramChange.date &&
          (prevDate === null || prevDate < paramChange.date)
        ) {
          // Calculate old circulating proportion before changes
          const oldCirculatingProportion = currentCirculatingProportion;

          // Apply changes to current params
          if (paramChange.changes.staking) {
            currentParams.staking = paramChange.changes.staking;
          }
          if (paramChange.changes.poolIncentives !== undefined) {
            currentParams.poolIncentives = paramChange.changes.poolIncentives;
          }
          if (paramChange.changes.osmoTakerFeeDistribution) {
            currentParams.osmoTakerFeeDistribution =
              paramChange.changes.osmoTakerFeeDistribution;
          }
          if (paramChange.changes.nonOsmoTakerFeeDistribution) {
            currentParams.nonOsmoTakerFeeDistribution =
              paramChange.changes.nonOsmoTakerFeeDistribution;
          }

          // Recalculate community pool
          currentParams.communityPool = calculateCommunityPool(
            currentParams.staking,
            currentParams.poolIncentives,
            currentParams.developerRewards
          );

          // Calculate new circulating proportion after changes
          const newCirculatingProportion =
            parseFloat(currentParams.staking) +
            parseFloat(currentParams.poolIncentives) +
            parseFloat(currentParams.developerRewards);

          // Log if circulating proportion changed
          if (oldCirculatingProportion !== newCirculatingProportion) {
            logger.info(
              `Circulating proportion changed at ${recordDate.toISOString().split("T")[0]}: ${(oldCirculatingProportion * 100).toFixed(0)}% -> ${(newCirculatingProportion * 100).toFixed(0)}%`
            );
            currentCirculatingProportion = newCirculatingProportion;
          }
        }
      }

      prevDate = recordDate;

      // Apply historical inflation increase for records before June 21, 2025
      // Since we don't have actual historical inflation data, we're modeling it
      // with a 50% increase for the earlier period
      if (record.inflationRate && recordDate < HISTORICAL_INFLATION_CUTOFF) {
        record.inflationRate = record.inflationRate * 1.5; // 50% increase
      }

      // Adjust inflation rate based on circulating proportion changes
      // The current inflation rate (1.95%) is based on current proportions (33% circulating)
      // When historical proportions had more circulating (95%), we need to adjust upward
      // Formula: adjusted_rate = current_rate * (historical_circulating / current_circulating)
      const CURRENT_CIRCULATING_PROPORTION = 0.33; // 8% staking + 25% dev + 0% liquidity
      if (
        record.inflationRate &&
        currentCirculatingProportion !== CURRENT_CIRCULATING_PROPORTION
      ) {
        const adjustmentFactor =
          currentCirculatingProportion / CURRENT_CIRCULATING_PROPORTION;
        record.inflationRate = record.inflationRate * adjustmentFactor;
      }

      // Apply current params to this record
      let updated = false;

      if (!record.distributionProportions) {
        record.distributionProportions = {
          staking: currentParams.staking,
          poolIncentives: currentParams.poolIncentives,
          developerRewards: currentParams.developerRewards,
          communityPool: currentParams.communityPool,
        };
        updated = true;
      } else {
        // Update if different
        if (
          record.distributionProportions.staking !== currentParams.staking ||
          record.distributionProportions.poolIncentives !==
            currentParams.poolIncentives ||
          record.distributionProportions.developerRewards !==
            currentParams.developerRewards ||
          record.distributionProportions.communityPool !==
            currentParams.communityPool
        ) {
          record.distributionProportions = {
            staking: currentParams.staking,
            poolIncentives: currentParams.poolIncentives,
            developerRewards: currentParams.developerRewards,
            communityPool: currentParams.communityPool,
          };
          updated = true;
        }
      }

      if (!record.osmoTakerFeeDistribution) {
        record.osmoTakerFeeDistribution = {
          stakingRewards: currentParams.osmoTakerFeeDistribution.stakingRewards,
          communityPool: currentParams.osmoTakerFeeDistribution.communityPool,
          burn: currentParams.osmoTakerFeeDistribution.burn,
        };
        updated = true;
      } else {
        if (
          record.osmoTakerFeeDistribution.stakingRewards !==
            currentParams.osmoTakerFeeDistribution.stakingRewards ||
          record.osmoTakerFeeDistribution.communityPool !==
            currentParams.osmoTakerFeeDistribution.communityPool ||
          record.osmoTakerFeeDistribution.burn !==
            currentParams.osmoTakerFeeDistribution.burn
        ) {
          record.osmoTakerFeeDistribution = {
            stakingRewards:
              currentParams.osmoTakerFeeDistribution.stakingRewards,
            communityPool: currentParams.osmoTakerFeeDistribution.communityPool,
            burn: currentParams.osmoTakerFeeDistribution.burn,
          };
          updated = true;
        }
      }

      if (!record.nonOsmoTakerFeeDistribution) {
        record.nonOsmoTakerFeeDistribution = {
          stakingRewards:
            currentParams.nonOsmoTakerFeeDistribution.stakingRewards,
          communityPool:
            currentParams.nonOsmoTakerFeeDistribution.communityPool,
          burn: currentParams.nonOsmoTakerFeeDistribution.burn,
        };
        updated = true;
      } else {
        if (
          record.nonOsmoTakerFeeDistribution.stakingRewards !==
            currentParams.nonOsmoTakerFeeDistribution.stakingRewards ||
          record.nonOsmoTakerFeeDistribution.communityPool !==
            currentParams.nonOsmoTakerFeeDistribution.communityPool ||
          record.nonOsmoTakerFeeDistribution.burn !==
            currentParams.nonOsmoTakerFeeDistribution.burn
        ) {
          record.nonOsmoTakerFeeDistribution = {
            stakingRewards:
              currentParams.nonOsmoTakerFeeDistribution.stakingRewards,
            communityPool:
              currentParams.nonOsmoTakerFeeDistribution.communityPool,
            burn: currentParams.nonOsmoTakerFeeDistribution.burn,
          };
          updated = true;
        }
      }

      if (updated) {
        updatedCount++;
      }
    }

    logger.info(`Updated ${updatedCount} records with historical parameters`);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    logger.info("Successfully saved updated history.json");
  } catch (error) {
    logger.error("Failed to apply historical parameters:", error);
    process.exit(1);
  }
}

applyHistoricalParams();
