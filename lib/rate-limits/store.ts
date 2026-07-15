// Persistence for the IBC rate-limit monitor.
//
// Snapshots follow the treasury pattern: the whole payload is one JSON blob
// per timestamp with headline numbers mirrored into columns, deduped to one
// row per UTC hour (the cron runs more often for alert latency, but hourly
// resolution is plenty for the flow-history baseline the quarterly review
// consumes). Alert states are one row per quota window, holding the last
// alerted level for cross-run de-duplication.
import { prisma, isDatabaseEnabled } from "../database";
import { Prisma } from "@prisma/client";
import { logger } from "../logger";
import type { RateLimitSnapshotData } from "./snapshot";
import type { AlertLevel, StoredAlertState } from "./alerts";

export async function saveRateLimitSnapshot(
  data: RateLimitSnapshotData
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

  await prisma.$transaction([
    prisma.rateLimitSnapshot.deleteMany({
      where: { timestamp: { gte: hourStart, lt: hourEnd } },
    }),
    prisma.rateLimitSnapshot.create({
      data: {
        timestamp: ts,
        pathCount: data.pathCount,
        maxUtilizationPct: data.maxUtilizationPct,
        data: data as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
  logger.info(`Saved rate-limit snapshot: ${data.timestamp}`);
}

export async function loadAlertStates(): Promise<
  Map<string, StoredAlertState>
> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }
  const rows = await prisma.rateLimitAlertState.findMany();
  return new Map(
    rows.map((row) => [
      row.pathKey,
      { level: row.level as AlertLevel, pct: Number(row.pct) },
    ])
  );
}

// Replace the alert-state set wholesale: recovered windows disappear, active
// ones are upserted. Runs in one transaction so an overlapping cron
// invocation cannot interleave a partial state.
export async function saveAlertStates(
  next: Map<string, StoredAlertState>
): Promise<void> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }
  const keys = [...next.keys()];
  await prisma.$transaction([
    prisma.rateLimitAlertState.deleteMany({
      where: keys.length > 0 ? { pathKey: { notIn: keys } } : {},
    }),
    ...[...next.entries()].map(([pathKey, state]) =>
      prisma.rateLimitAlertState.upsert({
        where: { pathKey },
        update: { level: state.level, pct: state.pct },
        create: { pathKey, level: state.level, pct: state.pct },
      })
    ),
  ]);
}
