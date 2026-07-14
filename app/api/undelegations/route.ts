import { NextResponse } from "next/server";
import { fetchUnbondingSchedule } from "@/lib/validators";
import { logger } from "@/lib/logger";

// The pending-undelegation (unbonding) schedule: true chain-wide total plus the
// per-completion-day amounts. Enumerates every bonded validator's
// unbonding_delegations (~13s), so it's cached hard at the edge — the schedule
// only shifts as new undelegations start and daily buckets complete.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const schedule = await fetchUnbondingSchedule();
    return NextResponse.json(schedule, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    logger.error("Undelegations route failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
