import { NextResponse } from "next/server";
import {
  calculateOsmosisMetrics,
  fetchInflation,
  fetchStakingApr,
  fetchFullMintParams,
  fetchPoolManagerParams,
  fetchTotalStaked,
} from "@/lib/osmosis-lcd";
import {
  saveSnapshot,
  getBurnRateFromHistory,
  getHistoryStats,
} from "@/lib/historical-file";
import { logger } from "@/lib/logger";
import type { OsmosisMetrics } from "@/types/osmosis";

export async function GET() {
  try {
    // Fetch current metrics in parallel for better performance
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

    // Get today's raw APR (most recent entry)
    const todayApr =
      aprData.entries.length > 0
        ? aprData.entries[aprData.entries.length - 1].apr
        : undefined;

    // Save snapshot to file (runs in background)
    saveSnapshot({
      timestamp,
      burnedSupply: metrics.burned,
      mintedSupply: metrics.mintedSupply,
      totalSupply: metrics.totalSupply,
      circulatingSupply: metrics.circulating,
      restrictedSupply: metrics.restrictedSupply,
      communitySupply: metrics.communitySupply,
      inflationRate: inflationRate,
      totalStaked: totalStaked,
      stakingApr: todayApr, // Raw APR for today
      stakingRate: aprData.average, // 30-day average
      // Revenue distribution parameters
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
    }).catch((error) => {
      logger.error("Failed to save snapshot:", error);
    });

    // Calculate burn rate from historical data (30 days)
    const burnRate = await getBurnRateFromHistory(30);

    // Calculate net inflation (inflation + burn rate, burn rate is negative)
    const netInflation = inflationRate + burnRate;

    // Get history stats for debugging
    const stats = await getHistoryStats();
    logger.debug("Historical data:", stats);

    const response: OsmosisMetrics = {
      burned: metrics.burned,
      mintedSupply: metrics.mintedSupply,
      totalSupply: metrics.totalSupply,
      circulating: metrics.circulating,
      restrictedSupply: metrics.restrictedSupply,
      communitySupply: metrics.communitySupply,
      inflationRate: inflationRate,
      burnRate: burnRate,
      netInflation: netInflation,
      stakingApr: aprData.average,
      timestamp: timestamp,
    };

    return NextResponse.json(response);
  } catch (error) {
    logger.error("Error fetching Osmosis metrics:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch Osmosis metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
