import { NextResponse } from "next/server";
import { buildRateLimitSnapshot } from "@/lib/rate-limits/snapshot";
import {
  computeAlertTransitions,
  sendTelegramAlerts,
} from "@/lib/rate-limits/alerts";
import {
  saveRateLimitSnapshot,
  loadAlertStates,
  saveAlertStates,
} from "@/lib/rate-limits/store";
import { logger } from "@/lib/logger";

// IBC rate-limit trip monitor. Triggered by Vercel Cron (see vercel.json)
// every 15 minutes: dumps the rate limiter contract's state, computes
// per-window quota utilization, Telegram-alerts on threshold escalations and
// recoveries, and stores an hourly-deduped snapshot whose history serves as
// the flow baseline for the quarterly rate-limit review.
//
// Ordering matters for at-least-once alerting: the snapshot is saved first
// (history is useful regardless), alerts are sent second, and alert states
// are persisted LAST — if Telegram delivery fails, the states are not
// advanced, so the same transitions fire again on the next run instead of
// being swallowed by the de-duplication.
//
// Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Requests
// without the matching bearer token are rejected.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET is not set; refusing to run rate-limit cron");
    return NextResponse.json({ error: "Cron not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshot = await buildRateLimitSnapshot();
    await saveRateLimitSnapshot(snapshot);

    const stored = await loadAlertStates();
    const { transitions, nextStates } = computeAlertTransitions(
      snapshot,
      stored
    );

    let delivered = false;
    if (transitions.length > 0) {
      delivered = await sendTelegramAlerts(transitions);
    }
    await saveAlertStates(nextStates);

    return NextResponse.json({
      ok: true,
      timestamp: snapshot.timestamp,
      endpoint: snapshot.endpoint,
      paths: snapshot.pathCount,
      maxUtilizationPct: snapshot.maxUtilizationPct,
      transitions: transitions.length,
      delivered,
    });
  } catch (error) {
    logger.error("Rate-limit cron failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
