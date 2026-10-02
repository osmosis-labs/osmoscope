import { NextResponse } from "next/server";
import {
  buildTreasurySnapshot,
  MainPoolMoveError,
  type TreasurySnapshotData,
} from "@/lib/treasury/snapshot";
import {
  saveTreasurySnapshot,
  getLatestTreasurySnapshot,
  recordPendingMove,
  clearPendingMoves,
} from "@/lib/treasury/store";
import { isMoveConfirmed, MOVE_CONFIRMATIONS } from "@/lib/treasury/move-gate";
import { logger } from "@/lib/logger";

// Hourly community-pool / DAO-treasury snapshot. Run by
// .github/workflows/cron.yml, NOT by page traffic — the build fans out to dozens of LCD,
// CosmWasm, and EVM calls and is far too heavy to run per request. The /treasury
// page reads the last stored snapshot instead.
//
// buildTreasurySnapshot() bounds its own concurrency and throws on a clearly
// broken result (main pool priced near zero), so a transient price-feed / LCD
// outage surfaces as a 500 and leaves the previous good row in place rather than
// overwriting it with garbage.
//
// A main-pool move over 15% (MainPoolMoveError) is held rather than dropped: the
// reading is recorded, and the snapshot is saved once MOVE_CONFIRMATIONS
// consecutive readings agree (lib/treasury/move-gate.ts). Otherwise a genuine
// large move, such as a big community-pool spend, would be refused by every
// later run too, because the baseline is the last saved snapshot.
//
// Security: requests need `Authorization: Bearer <CRON_SECRET>`; others are
// rejected. scripts/run-cron.ts sends it (with a per-run secret) when the
// GitHub Actions workflow runs the route.
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
    let snapshot: TreasurySnapshotData;
    let confirmedMove = false;
    try {
      snapshot = await buildTreasurySnapshot({
        previousMainPoolValue: previous?.mainPool.totalValue ?? null,
      });
    } catch (error) {
      if (!(error instanceof MainPoolMoveError)) throw error;
      const readings = await recordPendingMove(
        error.snapshot.timestamp,
        error.mainPoolValue,
        error.previousMainPoolValue
      );
      if (!isMoveConfirmed(readings)) {
        logger.warn(
          `${error.message} Held as a candidate (${readings.length} held; ` +
            `saves once ${MOVE_CONFIRMATIONS} consecutive readings agree).`
        );
        return NextResponse.json(
          {
            ok: false,
            saved: false,
            pendingConfirmation: true,
            heldReadings: readings.length,
            mainPoolValue: error.mainPoolValue,
            previousMainPoolValue: error.previousMainPoolValue,
            error: error.message,
          },
          { status: 202 }
        );
      }
      logger.info(
        `Treasury main pool move confirmed by ${MOVE_CONFIRMATIONS} consecutive ` +
          `readings ($${error.previousMainPoolValue.toFixed(0)} -> ` +
          `$${error.mainPoolValue.toFixed(0)}); saving.`
      );
      snapshot = error.snapshot;
      confirmedMove = true;
    }
    await saveTreasurySnapshot(snapshot);
    // The saved row is the new baseline, so held readings no longer apply. Not
    // fatal: the snapshot is already saved, and readings are matched on their
    // baseline, so any left behind can't count against the new one.
    try {
      await clearPendingMoves();
    } catch (error) {
      logger.warn("Failed to clear held treasury readings:", error);
    }
    return NextResponse.json({
      ok: true,
      saved: true,
      confirmedMove,
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
