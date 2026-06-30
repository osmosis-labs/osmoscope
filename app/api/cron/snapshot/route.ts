import { NextResponse } from "next/server";
import { buildAndSaveSnapshot } from "@/lib/snapshot";
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
const MAX_WAIT_MS = 240_000; // stop polling after ~4 min (within maxDuration)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    // The epoch the last snapshot was taken for (if any).
    const history = await getHistory();
    let lastEpoch = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].dayEpoch != null) {
        lastEpoch = history[i].dayEpoch as number;
        break;
      }
    }

    // If the newest record is already from today (UTC) — even one without a
    // dayEpoch, e.g. a deploy-day backfilled row — the day is already captured;
    // don't snapshot again. This guards the case where the epoch-only lastEpoch
    // walk would otherwise ignore that row and re-trigger. (The DB save also
    // replaces same-day rows, so a re-trigger is harmless, but skipping is cleaner.)
    const newest = history[history.length - 1];
    if (newest) {
      const n = new Date(newest.timestamp);
      const now = new Date();
      const sameUtcDay =
        n.getUTCFullYear() === now.getUTCFullYear() &&
        n.getUTCMonth() === now.getUTCMonth() &&
        n.getUTCDate() === now.getUTCDate();
      if (sameUtcDay) {
        logger.info("Today's snapshot already exists; skipping cron run");
        return NextResponse.json({
          ok: true,
          saved: false,
          reason: "already-captured-today",
        });
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
        const result = await buildAndSaveSnapshot(epoch.currentEpoch);
        return NextResponse.json({ ok: true, ...result });
      }
      if (Date.now() + POLL_INTERVAL_MS >= deadline) {
        logger.info(
          `Epoch ${epoch.currentEpoch} not advanced past ${lastEpoch} within wait window; will retry next run`
        );
        return NextResponse.json({
          ok: true,
          saved: false,
          reason: "epoch-not-advanced",
          currentEpoch: epoch.currentEpoch,
          lastEpoch,
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
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
