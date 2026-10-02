// Retention for the append-only cron tables, run daily by the snapshot cron.
// Each statement is idempotent (re-running keeps the same rows) and only
// thins whole UTC days older than its cutoff, so a day is never thinned while
// it is still being written.
//
// - treasury_snapshots: hourly for 7 days, then the last snapshot of each
//   day. The app reads only the latest row; older rows are a daily trend.
// - rate_limit_readings: hourly for 180 days, then per (channel, denom,
//   quota, day) the two hours that matter for the limit review: the highest
//   and the lowest (inflow - outflow) / channelValue. Utilization is net flow
//   over channelValue times a fixed per-quota percentage
//   (lib/rate-limits/snapshot.ts), so these are the day's peak recv and peak
//   send utilization. A day without a channel value keeps its last row.
// - rate_limit_snapshots (the caps and per-window utilization those readings
//   are measured against): hourly for 180 days, then the day's snapshot with
//   the highest maxUtilizationPct.
import { prisma, isDatabaseEnabled } from "./database";

const DAY_MS = 24 * 60 * 60 * 1000;

const TREASURY_HOURLY_DAYS = 7;
const RATE_LIMIT_HOURLY_DAYS = 180;

// Start of the UTC day `days` days ago: older days are complete.
const dayCutoff = (days: number): Date => {
  const now = Date.now();
  return new Date(now - (now % DAY_MS) - days * DAY_MS);
};

export interface RetentionResult {
  treasurySnapshots: number;
  rateLimitReadings: number;
  rateLimitSnapshots: number;
}

export async function pruneHistory(): Promise<RetentionResult> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  const treasuryCutoff = dayCutoff(TREASURY_HOURLY_DAYS);
  const treasurySnapshots = await prisma.$executeRaw`
    DELETE FROM treasury_snapshots
    WHERE timestamp < ${treasuryCutoff}
      AND id NOT IN (
        SELECT DISTINCT ON (date_trunc('day', timestamp AT TIME ZONE 'UTC')) id
        FROM treasury_snapshots
        WHERE timestamp < ${treasuryCutoff}
        ORDER BY date_trunc('day', timestamp AT TIME ZONE 'UTC'), timestamp DESC
      )`;

  const rateLimitCutoff = dayCutoff(RATE_LIMIT_HOURLY_DAYS);
  const rateLimitReadings = await prisma.$executeRaw`
    DELETE FROM rate_limit_readings r
    USING (
      SELECT timestamp, channel, denom, "quotaName",
        row_number() OVER (
          PARTITION BY channel, denom, "quotaName",
            date_trunc('day', timestamp AT TIME ZONE 'UTC')
          ORDER BY (inflow - outflow) / NULLIF("channelValue", 0) DESC NULLS LAST,
            timestamp DESC
        ) AS peak_recv,
        row_number() OVER (
          PARTITION BY channel, denom, "quotaName",
            date_trunc('day', timestamp AT TIME ZONE 'UTC')
          ORDER BY (inflow - outflow) / NULLIF("channelValue", 0) ASC NULLS LAST,
            timestamp DESC
        ) AS peak_send
      FROM rate_limit_readings
      WHERE timestamp < ${rateLimitCutoff}
    ) ranked
    WHERE r.timestamp = ranked.timestamp
      AND r.channel = ranked.channel
      AND r.denom = ranked.denom
      AND r."quotaName" = ranked."quotaName"
      AND ranked.peak_recv > 1
      AND ranked.peak_send > 1`;

  const rateLimitSnapshots = await prisma.$executeRaw`
    DELETE FROM rate_limit_snapshots
    WHERE timestamp < ${rateLimitCutoff}
      AND id NOT IN (
        SELECT DISTINCT ON (date_trunc('day', timestamp AT TIME ZONE 'UTC')) id
        FROM rate_limit_snapshots
        WHERE timestamp < ${rateLimitCutoff}
        ORDER BY date_trunc('day', timestamp AT TIME ZONE 'UTC'),
          "maxUtilizationPct" DESC, timestamp DESC
      )`;

  return { treasurySnapshots, rateLimitReadings, rateLimitSnapshots };
}
