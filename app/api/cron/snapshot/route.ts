import { NextResponse } from "next/server";
import { buildAndSaveSnapshot, refreshRecentRevenue } from "@/lib/snapshot";
import { fetchDayEpoch } from "@/lib/osmosis-lcd";
import { getHistory } from "@/lib/historical-file";
import { logger } from "@/lib/logger";

// Epoch-aware daily snapshot. Triggered by Vercel Cron (see vercel.json) shortly
// after the daily epoch window, NOT by page traffic.
//
// The chain's mint/inflation values only change when the "day" epoch advances.
// The cron is scheduled a few minutes after the nominal epoch time, but the epoch
// can be delayed or elongated. So rather than blindly snapshotting on a fixed
// clock, this route VERIFIES the epoch has actually advanced past the last
// snapshot's epoch (and is therefore queryable with the new values) before
// taking the snapshot. If the epoch hasn't advanced yet it polls briefly within
// the invocation so the snapshot lands as soon as the new epoch is live; if it
// still hasn't advanced by the deadline it exits without writing (the next cron
// run will catch it).
//
// Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Requests
// without the matching bearer token are rejected.
export const dynamic = "force-dynamic";
export const maxDuration = 300; // allow polling for a delayed epoch

const POLL_INTERVAL_MS = 20_000; // re-check the epoch every 20s
// Stop polling with enough headroom under maxDuration (300s) for the snapshot
// build itself: buildAndSaveSnapshot makes many sequential LCD calls (live
// restricted supply is slow, ~60-90s). Polling to ~240s left too little and an
// epoch that advanced late could be killed mid-build; 180s leaves ~120s to save.
const MAX_WAIT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The epoch-gated snapshot decision, factored out so the GET handler can always
// run the revenue refresh afterward (on every code path). Returns a plain result
// object; the caller wraps it in the JSON response. Throws on unexpected errors
// (the caller maps that to a 500).
async function runEpochSnapshot(): Promise<Record<string, unknown>> {
  // The epoch the last snapshot was taken for (if any).
  const history = await getHistory();
  let lastEpoch = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].dayEpoch != null) {
      lastEpoch = history[i].dayEpoch as number;
      break;
    }
  }

  // If a PROPER epoch snapshot already exists for today (UTC), skip — the day is
  // captured. We require dayEpoch to be set: a same-day row WITHOUT an epoch
  // (e.g. a deploy-day migrated/backfilled row, possibly with incomplete LCD
  // fields) must NOT block the real epoch-gated snapshot, or metrics would stay
  // stale all day. If the epoch gate then fires, the DB save replaces the
  // same-day row, so no duplicate accumulates.
  const newest = history[history.length - 1];
  if (newest && newest.dayEpoch != null) {
    const n = new Date(newest.timestamp);
    const now = new Date();
    const sameUtcDay =
      n.getUTCFullYear() === now.getUTCFullYear() &&
      n.getUTCMonth() === now.getUTCMonth() &&
      n.getUTCDate() === now.getUTCDate();
    if (sameUtcDay) {
      logger.info("Today's epoch snapshot already exists; skipping cron run");
      return { saved: false, reason: "already-captured-today" };
    }
  }

  // Poll until a NEW epoch is live (current > last snapshot's epoch), then snap.
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const epoch = await fetchDayEpoch();
    if (epoch.currentEpoch > lastEpoch) {
      logger.info(
        `Epoch advanced to ${epoch.currentEpoch} (last snapshot ${lastEpoch}); snapshotting`
      );
      return { ...(await buildAndSaveSnapshot(epoch.currentEpoch)) };
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      logger.info(
        `Epoch ${epoch.currentEpoch} not advanced past ${lastEpoch} within wait window; will retry next run`
      );
      return {
        saved: false,
        reason: "epoch-not-advanced",
        currentEpoch: epoch.currentEpoch,
        lastEpoch,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET is not set; refusing to run snapshot cron");
    return NextResponse.json({ error: "Cron not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // The epoch-snapshot decision. Runs to one of three outcomes, after which we
    // ALWAYS refresh protocol revenue (below) regardless of which path was taken —
    // revenue updates EXISTING rows and is independent of whether a new snapshot
    // was written, so it must not be gated behind the epoch logic's early exits.
    const epochResult = await runEpochSnapshot();

    // Refresh recent protocol revenue on every cron run (Data Lenses lags several
    // days; this backfills as it publishes). Guarded internally — never throws.
    const revenueFilled = await refreshRecentRevenue();

    return NextResponse.json({ ok: true, ...epochResult, revenueFilled });
  } catch (error) {
    logger.error("Snapshot cron failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
