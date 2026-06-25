import { NextResponse } from "next/server";
import { buildAndSaveSnapshot } from "@/lib/snapshot";
import { logger } from "@/lib/logger";

// Scheduled daily snapshot. Triggered by Vercel Cron (see vercel.json), NOT by
// page traffic, so the historical series stays gap-free regardless of visits.
//
// Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. We reject
// any request whose bearer token does not match CRON_SECRET, so the endpoint
// cannot be triggered by the public. If CRON_SECRET is unset we refuse rather
// than run unauthenticated.
export const dynamic = "force-dynamic";
export const maxDuration = 60; // snapshot does ~6 sequential LCD fetches

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
    const result = await buildAndSaveSnapshot();
    return NextResponse.json({ ok: true, ...result });
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
