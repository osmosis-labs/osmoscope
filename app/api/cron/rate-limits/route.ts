import { NextResponse } from "next/server";
import { buildRateLimitSnapshot } from "@/lib/rate-limits/snapshot";
import { computeAlertTransitions } from "@/lib/rate-limits/alerts";
import { dispatchAlerts, sendOpsNotice } from "@/lib/rate-limits/notify";
import {
  saveRateLimitSnapshot,
  loadAlertStates,
  saveAlertStates,
} from "@/lib/rate-limits/store";
import { logger } from "@/lib/logger";

// IBC rate-limit trip monitor. Triggered by Vercel Cron (see vercel.json)
// every 15 minutes: dumps the rate limiter contract's state, computes
// per-window quota utilization, alerts the configured channels (Telegram,
// Slack) on threshold escalations and
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

// A safety monitor's worst state is "dead and nobody knows": a broken run
// (DB outage, dump failure) only produces 500s that nothing watches. Send a
// best-effort degraded notice to ONE ops channel (the dispatcher picks the
// first configured), rate-limited per warm instance so an extended outage
// doesn't page every 15 minutes.
const DEGRADED_NOTICE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastDegradedNoticeAt = 0;
// Consecutive-failure counter (per warm instance) so the notice can say
// whether this is a blip or a sustained outage.
let consecutiveFailures = 0;

// Which stage of the run failed — so ops knows WHERE it broke, not just that
// it did. Carried on the thrown error via CronStageError below.
type CronStage =
  | "dump"
  | "persist-snapshot"
  | "load-state"
  | "alerts"
  | "persist-state";

class CronStageError extends Error {
  constructor(
    readonly stage: CronStage,
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CronStageError";
  }
}

const STAGE_LABEL: Record<CronStage, string> = {
  dump: "reading the rate-limiter contract state",
  "persist-snapshot": "saving the snapshot to the database",
  "load-state": "loading prior alert state from the database",
  alerts: "delivering alerts to the notification channels",
  "persist-state": "saving alert state to the database",
};

// Turn a raw error into a plain-English operator hint + likely next action.
// Keyed off the recurring failure modes so the notice is actionable, not just
// a stack-trace fragment. Falls back to the raw message for anything unmapped.
function diagnose(message: string): { hint: string; action: string } | null {
  const m = message.toLowerCase();
  if (m.includes("unable to start a transaction")) {
    return {
      hint: "Database connection pool is saturated (too many concurrent connections across the cron fleet + API routes).",
      action:
        "Check the Prisma Postgres plan's connection limit (console.prisma.io); the per-instance pool cap (DB_POOL_MAX) bounds client usage.",
    };
  }
  if (m.includes("521") || m.includes("522") || m.includes("523")) {
    return {
      hint: "The LCD endpoint's origin is down (Cloudflare 52x).",
      action:
        "Transient if a fallback endpoint exists; if it persists, the node behind the endpoint needs a restart.",
    };
  }
  if (
    m.includes("timeout") ||
    m.includes("etimedout") ||
    m.includes("econnrefused")
  ) {
    return {
      hint: "An upstream (LCD / database) was unreachable or too slow.",
      action:
        "Usually transient; the next run retries. Watch for a sustained streak.",
    };
  }
  if (m.includes("empty") || m.includes("truncated") || m.includes("decode")) {
    return {
      hint: "The contract state dump came back empty or malformed (possible key-layout drift after a migration).",
      action:
        "Verify the rate-limiter contract address and that its state layout hasn't changed.",
    };
  }
  return null;
}

async function sendDegradedNotice(error: unknown): Promise<void> {
  if (Date.now() - lastDegradedNoticeAt < DEGRADED_NOTICE_INTERVAL_MS) return;
  const message = error instanceof Error ? error.message : String(error);
  const stage = error instanceof CronStageError ? error.stage : null;
  const diag = diagnose(message);

  const lines = [
    stage
      ? `Failed while ${STAGE_LABEL[stage]}.`
      : "The run failed before completing.",
    "",
    `Error: ${message}`,
  ];
  if (diag) {
    lines.push("", `Likely cause: ${diag.hint}`, `Next step: ${diag.action}`);
  }
  lines.push(
    "",
    `This is failure #${consecutiveFailures} in a row on this instance.`,
    "Utilization is NOT being watched until a run succeeds.",
    "(Further degraded notices are suppressed for 6h to avoid paging every 15 min.)"
  );

  try {
    await sendOpsNotice("Rate-limit monitor degraded", lines.join("\n"));
    lastDegradedNoticeAt = Date.now();
  } catch {
    // The ops channel itself is unreachable — nothing more to do beyond logs.
  }
}

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

  // Manual delivery test (?test=1): push a clearly-labelled synthetic alert
  // through the REAL dispatcher (every configured channel and chat, real
  // formatting and chunking) plus a test ops-notice, without touching the
  // snapshot or alert states. Verifies the wiring end to end the moment env
  // vars land, instead of waiting for a genuine threshold trip.
  if (new URL(request.url).searchParams.get("test") === "1") {
    try {
      const result = await dispatchAlerts([
        {
          pathKey: "test|test|TEST",
          symbol: "DELIVERY TEST",
          quotaName: "(ignore me)",
          direction: "out",
          pct: 80,
          from: null,
          to: "warn",
        },
      ]);
      await sendOpsNotice(
        "Delivery test",
        "This is a test of the ops-notice path. Ignore."
      );
      return NextResponse.json({ ok: true, test: true, ...result });
    } catch (error) {
      return NextResponse.json(
        {
          ok: false,
          test: true,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }

  // Run each stage tagged with its name, so a failure carries WHERE it broke
  // into the degraded notice. `stage(name, fn)` rethrows as a CronStageError.
  const stage = async <T>(
    name: CronStage,
    fn: () => Promise<T>
  ): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new CronStageError(name, e);
    }
  };

  try {
    const snapshot = await stage("dump", () => buildRateLimitSnapshot());
    await stage("persist-snapshot", () => saveRateLimitSnapshot(snapshot));

    const stored = await stage("load-state", () => loadAlertStates());
    const { transitions, nextStates } = computeAlertTransitions(
      snapshot,
      stored
    );

    let delivered = false;
    if (transitions.length > 0) {
      // Throws if any configured channel failed, so states below are NOT
      // advanced and the batch re-fires next run (at-least-once).
      delivered = (await stage("alerts", () => dispatchAlerts(transitions)))
        .delivered;
    }
    await stage("persist-state", () => saveAlertStates(nextStates));

    consecutiveFailures = 0; // a clean run clears the streak
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
    consecutiveFailures += 1;
    const stageName = error instanceof CronStageError ? error.stage : "unknown";
    logger.error(`Rate-limit cron failed [stage=${stageName}]:`, error);
    await sendDegradedNotice(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { ok: false, stage: stageName, error: message },
      { status: 500 }
    );
  }
}
