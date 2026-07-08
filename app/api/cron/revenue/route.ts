import { NextResponse } from "next/server";
import { refreshRecentRevenue } from "@/lib/snapshot";
import { logger } from "@/lib/logger";

// Hourly protocol-revenue refresh. Triggered by Vercel Cron (see vercel.json).
//
// Revenue comes from Data Lenses, which lags the chain by several days and
// publishes a given day at an unpredictable hour. This is deliberately a
// SEPARATE, hourly cron rather than being tied to the daily snapshot cron
// (15/45 17 * * *): that cron fires only twice a day within one 30-minute
// window, so if Data Lenses hadn't published "today" by 17:15 UTC the fill
// waited a full day (the bug this route fixes). Running hourly, revenue lands
// within ~1h of upstream publishing. It's also independent of the snapshot and
// treasury builds, so a failure in either can't skip it.
//
// refreshRecentRevenue() backfills existing rows over a rolling ~14-day window
// and is idempotent + internally guarded (never throws), so re-running hourly is
// cheap and safe.
//
// Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Requests
// without the matching bearer token are rejected.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET is not set; refusing to run revenue cron");
    return NextResponse.json({ error: "Cron not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const revenueFilled = await refreshRecentRevenue();
  return NextResponse.json({ ok: true, revenueFilled });
}
