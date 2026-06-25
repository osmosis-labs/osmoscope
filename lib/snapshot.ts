// Builds a daily historical snapshot record from current chain state and
// persists it (via saveSnapshot, which dedupes per day). Extracted so both the
// scheduled cron route (/api/cron/snapshot) and any other caller share one
// definition of "what a snapshot contains".
import {
  calculateOsmosisMetrics,
  fetchInflation,
  fetchStakingApr,
  fetchFullMintParams,
  fetchPoolManagerParams,
  fetchTotalStaked,
} from "./osmosis-lcd";
import { saveSnapshot } from "./historical-file";
import { logger } from "./logger";

export interface SnapshotResult {
  saved: boolean;
  timestamp: string;
}

// Fetch current metrics and persist a snapshot. saveSnapshot internally guards
// against duplicate same-day writes, so this is safe to call more than once.
export async function buildAndSaveSnapshot(): Promise<SnapshotResult> {
  const [
    metrics,
    inflationRate,
    aprData,
    mintParams,
    poolManagerParams,
    totalStaked,
  ] = await Promise.all([
    calculateOsmosisMetrics(),
    fetchInflation(),
    fetchStakingApr(),
    fetchFullMintParams(),
    fetchPoolManagerParams(),
    fetchTotalStaked(),
  ]);

  const timestamp = new Date().toISOString();

  const todayApr =
    aprData.entries.length > 0
      ? aprData.entries[aprData.entries.length - 1].apr
      : undefined;

  await saveSnapshot({
    timestamp,
    burnedSupply: metrics.burned,
    mintedSupply: metrics.mintedSupply,
    totalSupply: metrics.totalSupply,
    circulatingSupply: metrics.circulating,
    restrictedSupply: metrics.restrictedSupply,
    communitySupply: metrics.communitySupply,
    inflationRate,
    totalStaked,
    stakingApr: todayApr,
    stakingRate: aprData.average,
    distributionProportions: mintParams
      ? {
          staking: mintParams.distribution_proportions.staking,
          poolIncentives: mintParams.distribution_proportions.pool_incentives,
          developerRewards:
            mintParams.distribution_proportions.developer_rewards,
          communityPool: mintParams.distribution_proportions.community_pool,
        }
      : undefined,
    osmoTakerFeeDistribution: poolManagerParams
      ? {
          stakingRewards:
            poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
              .staking_rewards,
          communityPool:
            poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
              .community_pool,
          burn: poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
            .burn,
        }
      : undefined,
    nonOsmoTakerFeeDistribution: poolManagerParams
      ? {
          stakingRewards:
            poolManagerParams.taker_fee_params.non_osmo_taker_fee_distribution
              .staking_rewards,
          communityPool:
            poolManagerParams.taker_fee_params.non_osmo_taker_fee_distribution
              .community_pool,
          burn: poolManagerParams.taker_fee_params
            .non_osmo_taker_fee_distribution.burn,
        }
      : undefined,
    communityPoolDenomWhitelist:
      poolManagerParams?.community_pool_denom_whitelist,
    communityPoolDenomToSwapNonWhitelistedAssetsTo:
      poolManagerParams?.taker_fee_params
        .community_pool_denom_to_swap_non_whitelisted_assets_to,
  });

  logger.info(`Snapshot persisted for ${timestamp}`);
  return { saved: true, timestamp };
}
