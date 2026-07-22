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

  // The per-denom raw flow readings (the queryable series), one row per
  // window: same hour-dedupe as the blob so the two stay in lockstep. Keyed by
  // quota NAME (names are unique within a path), not duration — two quotas
  // sharing a duration would otherwise collide on the PK and roll back the
  // whole transaction, killing the monitor until a schema change.
  const readings = data.paths.flatMap((p) =>
    p.windows.map((w) => ({
      timestamp: ts,
      channel: p.channel,
      denom: p.denom,
      quotaName: w.quotaName,
      durationSeconds: w.durationSeconds,
      channelValue: w.channelValue,
      inflow: w.inflow,
      outflow: w.outflow,
    }))
  );

  // Interactive (callback) form, NOT the array form: the array form has a
  // FIXED 5s total timeout that also bounds transaction ACQUISITION, so under
  // connection-pool contention (this 15-min cron overlapping the snapshot /
  // treasury / revenue crons on the shared Prisma Postgres pool) it
  // intermittently threw "Unable to start a transaction in the given time" and
  // tripped the degraded alert. The callback form takes maxWait (acquisition
  // budget) and timeout (run budget) explicitly.
  await prisma.$transaction(
    async (tx) => {
      await tx.rateLimitSnapshot.deleteMany({
        where: { timestamp: { gte: hourStart, lt: hourEnd } },
      });
      await tx.rateLimitSnapshot.create({
        data: {
          timestamp: ts,
          pathCount: data.pathCount,
          maxUtilizationPct: data.maxUtilizationPct,
          data: data as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.rateLimitReading.deleteMany({
        where: { timestamp: { gte: hourStart, lt: hourEnd } },
      });
      // skipDuplicates as a belt-and-braces guard: even an unforeseen key
      // collision must degrade to a dropped row, never a rolled-back snapshot.
      await tx.rateLimitReading.createMany({
        data: readings,
        skipDuplicates: true,
      });
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
  logger.info(
    `Saved rate-limit snapshot: ${data.timestamp} (${readings.length} readings)`
  );
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
  // Callback form for the same reason as saveRateLimitSnapshot: the array
  // form's fixed 5s timeout bounds acquisition and throws under pool
  // contention. maxWait covers acquisition, timeout the run.
  await prisma.$transaction(
    async (tx) => {
      await tx.rateLimitAlertState.deleteMany({
        where: keys.length > 0 ? { pathKey: { notIn: keys } } : {},
      });
      for (const [pathKey, state] of next.entries()) {
        await tx.rateLimitAlertState.upsert({
          where: { pathKey },
          update: { level: state.level, pct: state.pct },
          create: { pathKey, level: state.level, pct: state.pct },
        });
      }
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}
