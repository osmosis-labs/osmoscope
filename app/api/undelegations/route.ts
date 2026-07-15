import { NextResponse } from "next/server";
import {
  fetchUnbondingSchedule,
  type UnbondingSchedule,
} from "@/lib/validators";
import {
  getUndelegationDays,
  getUnbondingForecast,
} from "@/lib/historical-file-db";
import { logger } from "@/lib/logger";

// The pending-undelegation (unbonding) forecast + per-completion-day history.
//
// The forecast (outstanding total, forward buckets, top entries) is computed ONCE
// A DAY by the snapshot cron — enumerating every bonded validator's
// unbonding_delegations is a ~71-call LCD fan-out that the public LCD rate-limits
// (403) if run per request. So we serve the cron's stored blob here and never
// fan out on a page load. Only if no blob exists yet (fresh deploy before the
// first cron run) do we fall back to a single live fetch. The per-completion-day
// history comes from UndelegationDay (backfilled + cron).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const [forecast, history] = await Promise.all([
      getUnbondingForecast().catch((e) => {
        logger.warn(
          `Unbonding forecast read failed: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }),
      getUndelegationDays().catch((e) => {
        logger.warn(
          `Undelegation history read skipped: ${e instanceof Error ? e.message : String(e)}`
        );
        return [] as { date: string; amountCompleting: number }[];
      }),
    ]);

    // Serve the cron's stored forecast; fall back to a live fetch only if the
    // cron hasn't populated it yet (first deploy). The live fallback is the
    // expensive fan-out, so it should essentially never run in steady state.
    let schedule: UnbondingSchedule;
    let computedAt: string | null;
    if (forecast?.data) {
      schedule = forecast.data as UnbondingSchedule;
      computedAt = forecast.computedAt;
    } else {
      logger.warn(
        "No stored unbonding forecast; falling back to a live fan-out (first run?)."
      );
      schedule = await fetchUnbondingSchedule();
      computedAt = new Date().toISOString();
    }

    return NextResponse.json(
      // computedAt = when the forecast fan-out ran, so the UI can show staleness.
      { ...schedule, history, computedAt },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      }
    );
  } catch (error) {
    logger.error("Undelegations route failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
