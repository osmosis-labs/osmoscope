import { NextResponse } from "next/server";
import {
  calculateOsmosisMetrics,
  fetchInflation,
  fetchStakingApr,
} from "@/lib/osmosis-lcd";
import { getBurnRateFromHistory, getHistoryStats } from "@/lib/historical-file";
import { logger } from "@/lib/logger";
import type { OsmosisMetrics } from "@/types/osmosis";

// The live metrics change slowly (supply, inflation, and the staking pool update
// once per daily epoch; staking APR is a 30-day average), so the response is
// CDN-cached for 5 minutes via the Cache-Control header on the response below.
// This matches the client's React Query refetch cadence and keeps serverless
// invocations and LCD calls low under public traffic. The route is dynamic (it
// reads live DB/LCD state), so caching is header-driven rather than via the
// route-segment `revalidate` export.

export async function GET() {
  try {
    // Fetch the live metrics this endpoint serves, in parallel. Distribution and
    // pool-manager params and total-staked are only needed for the daily snapshot
    // (now written by /api/cron/snapshot), so they are no longer fetched here.
    const [metrics, inflationRate, aprData] = await Promise.all([
      calculateOsmosisMetrics(),
      fetchInflation(),
      fetchStakingApr(),
    ]);
    const timestamp = new Date().toISOString();

    // NOTE: This endpoint is read-only. The daily historical snapshot is written
    // by the scheduled cron route (/api/cron/snapshot, see vercel.json), not as a
    // side effect of serving metrics, so the historical series stays gap-free
    // regardless of page traffic.

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

    return NextResponse.json(response, {
      headers: {
        // CDN-cache for 5 minutes; serve stale for up to a minute more while a
        // fresh copy is fetched in the background. Errors below are not cached.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    logger.error("Error fetching Osmosis metrics:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch Osmosis metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
