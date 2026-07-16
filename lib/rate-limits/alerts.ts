// Alert thresholds and transition computation for the rate-limit monitor.
// Pure compute: delivery (Telegram/Slack channels, chunking, escaping) lives
// in lib/rate-limits/notify.ts.
//
// The monitor alerts on level ESCALATION and recovery only, never on steady
// state: the previous alerted level per window lives in the database
// (RateLimitAlertState), so a window sitting at 85% for a week produces one
// warning and one all-clear, not a message every cron run.
import { shortDenom, type RateLimitSnapshotData } from "./snapshot";

export type AlertLevel = "warn" | "urgent" | "blocking";

export const WARN_PCT = 80;
export const URGENT_PCT = 95;
export const BLOCKING_PCT = 100;

const LEVEL_RANK: Record<AlertLevel, number> = {
  warn: 1,
  urgent: 2,
  blocking: 3,
};

export function levelFor(pct: number): AlertLevel | null {
  if (pct >= BLOCKING_PCT) return "blocking";
  if (pct >= URGENT_PCT) return "urgent";
  if (pct >= WARN_PCT) return "warn";
  return null;
}

export interface StoredAlertState {
  level: AlertLevel;
  pct: number;
}

export interface AlertTransition {
  pathKey: string;
  symbol: string;
  quotaName: string;
  direction: "in" | "out" | null;
  pct: number;
  from: AlertLevel | null;
  // null means recovered (dropped below the warn threshold, or the window
  // reset / the limit was removed).
  to: AlertLevel | null;
}

// Diff the current snapshot against the stored alert states. Returns the
// transitions to notify about and the complete next state set (only entries
// at or above warn are kept).
export function computeAlertTransitions(
  snapshot: RateLimitSnapshotData,
  stored: Map<string, StoredAlertState>
): {
  transitions: AlertTransition[];
  nextStates: Map<string, StoredAlertState>;
} {
  const transitions: AlertTransition[] = [];
  const nextStates = new Map<string, StoredAlertState>();
  const seen = new Set<string>();

  for (const path of snapshot.paths) {
    for (const window of path.windows) {
      if (window.utilizationPct === null) continue;
      const pathKey = `${path.channel}|${path.denom}|${window.quotaName}`;
      seen.add(pathKey);
      const level = levelFor(window.utilizationPct);
      const previous = stored.get(pathKey) ?? null;

      if (level) {
        nextStates.set(pathKey, { level, pct: window.utilizationPct });
        // Notify on escalation only; de-escalations that stay above warn are
        // recorded silently so a later re-escalation still fires.
        if (!previous || LEVEL_RANK[level] > LEVEL_RANK[previous.level]) {
          transitions.push({
            pathKey,
            symbol: path.symbol,
            quotaName: window.quotaName,
            direction: window.direction,
            pct: window.utilizationPct,
            from: previous?.level ?? null,
            to: level,
          });
        }
      } else if (previous) {
        transitions.push({
          pathKey,
          symbol: path.symbol,
          quotaName: window.quotaName,
          direction: window.direction,
          pct: window.utilizationPct,
          from: previous.level,
          to: null,
        });
      }
    }
  }

  // Stored states whose window vanished entirely (limit removed, window
  // expired and reset, or path renamed) also recover. Only the raw denom is
  // recoverable from the pathKey (the symbol map belongs to the live snapshot,
  // which this window is no longer in), so shorten it rather than posting a
  // 60-char ibc/HASH as the bold "symbol".
  for (const [pathKey, previous] of stored) {
    if (seen.has(pathKey)) continue;
    const [, denom, quotaName] = pathKey.split("|");
    transitions.push({
      pathKey,
      symbol: shortDenom(denom ?? pathKey),
      quotaName: quotaName ?? "",
      direction: null,
      pct: 0,
      from: previous.level,
      to: null,
    });
  }

  return { transitions, nextStates };
}
