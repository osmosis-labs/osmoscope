import { NextResponse } from "next/server";
import { fetchDecentralizationMetrics } from "@/lib/validators";
import { logger } from "@/lib/logger";

// Live validator / decentralization metrics for the /network page: Nakamoto,
// Gini, voting-power distribution, leaderboard, and the pending-undelegation
// aggregate. Served on request (the underlying LCD queries are light and cached
// in lib/osmosis-lcd), unlike the treasury route which reads a stored snapshot.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const metrics = await fetchDecentralizationMetrics();
    return NextResponse.json(metrics, {
      // Cache at the edge for a few minutes: the validator set changes at most
      // once per epoch, so per-request live fetches aren't needed.
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    logger.error("Validators route failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
