import { NextResponse } from "next/server";
import { buildTreasurySnapshot } from "@/lib/treasury/snapshot";
import {
  saveTreasurySnapshot,
  getLatestTreasurySnapshot,
} from "@/lib/treasury/store";
import { logger } from "@/lib/logger";

// Hourly community-pool / DAO-treasury snapshot. Triggered by Vercel Cron (see
// vercel.json), NOT by page traffic — the build fans out to dozens of LCD,
// CosmWasm, and EVM calls and is far too heavy to run per request. The /treasury
// page reads the last stored snapshot instead.
//
// buildTreasurySnapshot() bounds its own concurrency and throws on a clearly
// broken result (main pool priced near zero), so a transient price-feed / LCD
// outage surfaces as a 500 and leaves the previous good row in place rather than
// overwriting it with garbage.
//
// Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Requests
// without the matching bearer token are rejected.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error("CRON_SECRET is not set; refusing to run treasury cron");
    return NextResponse.json({ error: "Cron not configured" }, { status: 500 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Pass the last good main-pool value so the builder's proportional-move gate
    // can reject a partial fetch instead of overwriting a good row.
    const previous = await getLatestTreasurySnapshot();
    const snapshot = await buildTreasurySnapshot({
      previousMainPoolValue: previous?.mainPool.totalValue ?? null,
    });
    await saveTreasurySnapshot(snapshot);
    return NextResponse.json({
      ok: true,
      saved: true,
      timestamp: snapshot.timestamp,
      totalValue: snapshot.totalValue,
      holders: snapshot.holders.length,
      unpriced: snapshot.unpricedSymbols.length,
    });
  } catch (error) {
    logger.error("Treasury cron failed:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
