// Alert thresholds, de-duplication, and Telegram delivery for the rate-limit
// monitor.
//
// The monitor alerts on level ESCALATION and recovery only, never on steady
// state: the previous alerted level per window lives in the database
// (RateLimitAlertState), so a window sitting at 85% for a week produces one
// warning and one all-clear, not a message every cron run.
import { logger } from "../logger";
import type { RateLimitSnapshotData } from "./snapshot";

export type AlertLevel = "warn" | "urgent" | "blocking";

export const WARN_PCT = 80;
export const URGENT_PCT = 95;
export const BLOCKING_PCT = 100;

const LEVEL_RANK: Record<AlertLevel, number> = {
  warn: 1,
  urgent: 2,
  blocking: 3,
};

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  warn: "⚠️",
  urgent: "🚨",
  blocking: "⛔",
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
  // expired and reset, or path renamed) also recover.
  for (const [pathKey, previous] of stored) {
    if (seen.has(pathKey)) continue;
    const [, , quotaName] = pathKey.split("|");
    transitions.push({
      pathKey,
      symbol: pathKey.split("|")[1],
      quotaName,
      direction: null,
      pct: 0,
      from: previous.level,
      to: null,
    });
  }

  return { transitions, nextStates };
}

function describe(transition: AlertTransition): string {
  const directionLabel =
    transition.direction === "out"
      ? "outflow"
      : transition.direction === "in"
        ? "inflow"
        : "flow";
  if (transition.to === null) {
    return `✅ <b>${transition.symbol}</b> ${transition.quotaName}: back below ${WARN_PCT}%`;
  }
  const suffix = transition.to === "blocking" ? " — transfers blocked" : "";
  return `${LEVEL_EMOJI[transition.to]} <b>${transition.symbol}</b> ${transition.quotaName}: ${transition.pct.toFixed(1)}% of ${directionLabel} cap${suffix}`;
}

// Send one batched Telegram message for the run's transitions. Returns false
// (after logging the content) when the bot env vars are not configured, so
// the monitor still functions as a log-only checker. Throws on delivery
// failure so the caller can skip persisting alert states and retry next run.
export async function sendTelegramAlerts(
  transitions: AlertTransition[]
): Promise<boolean> {
  const lines = transitions.map(describe);
  const text = `<b>Osmosis IBC rate limits</b>\n${lines.join("\n")}`;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logger.warn(`Telegram not configured; rate-limit alerts:\n${text}`);
    return false;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
  } | null;
  if (!response.ok || !body?.ok) {
    throw new Error(
      `Telegram send failed: ${response.status} ${body?.description ?? ""}`
    );
  }
  return true;
}
