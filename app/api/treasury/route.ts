import { NextResponse } from "next/server";
import { getLatestTreasurySnapshot } from "@/lib/treasury/store";
import { buildTreasurySnapshot } from "@/lib/treasury/snapshot";
import { logger } from "@/lib/logger";

// The live build fans out to many chain calls and takes ~30s; allow it (dev only).
export const maxDuration = 60;

// Serves the latest stored community-pool / DAO-treasury snapshot for the
// /treasury page. The snapshot is refreshed hourly by the treasury cron, so cache
// at the CDN for ~15 min and serve stale while revalidating.
const TREASURY_CACHE_CONTROL =
  "public, s-maxage=900, stale-while-revalidate=900";

const IS_DEV = process.env.NODE_ENV !== "production";

export async function GET() {
  try {
    // In development the DB is usually not running and the table may not exist,
    // so reading the stored snapshot can return null OR throw. Either way, build
    // one live so the page renders for local design work. Production NEVER does
    // this — the ~30s build must not run on a user request; it reads the stored
    // hourly snapshot only.
    let snapshot = null;
    try {
      snapshot = await getLatestTreasurySnapshot();
    } catch (dbError) {
      if (!IS_DEV) throw dbError;
      logger.warn(
        `Treasury store unavailable in dev; building live: ${
          dbError instanceof Error ? dbError.message : dbError
        }`
      );
    }

    if (!snapshot && IS_DEV) {
      const live = await buildTreasurySnapshot();
      return NextResponse.json(live, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (!snapshot) {
      // No snapshot has been taken yet (fresh deploy before the first cron run).
      return NextResponse.json(
        { error: "No treasury snapshot available yet" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": TREASURY_CACHE_CONTROL },
    });
  } catch (error) {
    logger.error("Error fetching treasury snapshot:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch treasury snapshot",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
