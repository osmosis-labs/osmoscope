import { NextResponse } from "next/server";
import type { UnbondingSchedule } from "@/lib/validators";
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
// fan out on a request: with no stored forecast (a failed read, or a fresh
// database before the first cron run) the route answers 503, uncached, rather
// than letting cache-busted requests drive the fan-out. The per-completion-day
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

    if (!forecast?.data) {
      return NextResponse.json(
        { error: "Unbonding forecast is temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const schedule = forecast.data as UnbondingSchedule;
    const computedAt: string | null = forecast.computedAt;

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
      { error: "Failed to fetch undelegations" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
