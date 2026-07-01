// Persistence for the community-pool / DAO-treasury snapshot.
//
// The whole TreasurySnapshotData is stored as a single JSON blob per timestamp
// (the page reads it whole; nothing queries it by column), with the headline
// totalValue mirrored into a Decimal column for cheap access. Mirrors the
// day-dedup pattern of saveSnapshotToDatabase, but keyed on the UTC HOUR since
// the treasury cron runs hourly.
import { prisma, isDatabaseEnabled } from "../database";
import { Prisma } from "@prisma/client";
import { logger } from "../logger";
import type { TreasurySnapshotData } from "./snapshot";

// Save a treasury snapshot, replacing any existing row for the same UTC hour so
// re-runs within the hour update rather than append. The delete + create run in
// one transaction so overlapping cron invocations can't both insert for the same
// hour (matches the historical-record cross-invocation guard).
export async function saveTreasurySnapshot(
  data: TreasurySnapshotData
): Promise<void> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  const ts = new Date(data.timestamp);
  const hourStart = new Date(
    Date.UTC(
      ts.getUTCFullYear(),
      ts.getUTCMonth(),
      ts.getUTCDate(),
      ts.getUTCHours()
    )
  );
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

  try {
    await prisma.$transaction([
      prisma.treasurySnapshot.deleteMany({
        where: { timestamp: { gte: hourStart, lt: hourEnd } },
      }),
      prisma.treasurySnapshot.create({
        data: {
          timestamp: ts,
          totalValue: data.totalValue,
          // Structured payload is a plain JSON object; cast to Prisma's JSON
          // input type (it round-trips as `unknown` on read).
          data: data as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);
    logger.info(`Saved treasury snapshot to database: ${data.timestamp}`);
  } catch (error) {
    logger.error("Failed to save treasury snapshot:", error);
    throw error;
  }
}

// Latest stored treasury snapshot, or null if none exists yet.
export async function getLatestTreasurySnapshot(): Promise<TreasurySnapshotData | null> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  const row = await prisma.treasurySnapshot.findFirst({
    orderBy: { timestamp: "desc" },
  });
  if (!row) return null;
  return row.data as unknown as TreasurySnapshotData;
}
