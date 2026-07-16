// Alert thresholds, de-duplication, and Telegram delivery for the rate-limit
// monitor.
//
// The monitor alerts on level ESCALATION and recovery only, never on steady
// state: the previous alerted level per window lives in the database
// (RateLimitAlertState), so a window sitting at 85% for a week produces one
// warning and one all-clear, not a message every cron run.
import { logger } from "../logger";
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

// Symbols and quota names come from external data (the assetlist, contract
// state); one `&` or `<` in either would make Telegram reject the HTML
// message — permanently, since delivery failure blocks state persistence and
// the same poisoned batch retries forever. Escape at the boundary. Exported
// for other callers composing HTML-mode messages (the cron's degraded notice).
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function describe(transition: AlertTransition): string {
  const directionLabel =
    transition.direction === "out"
      ? "outflow"
      : transition.direction === "in"
        ? "inflow"
        : "flow";
  const symbol = escapeHtml(transition.symbol);
  const quotaName = escapeHtml(transition.quotaName);
  if (transition.to === null) {
    return `✅ <b>${symbol}</b> ${quotaName}: back below ${WARN_PCT}%`;
  }
  const suffix = transition.to === "blocking" ? " — transfers blocked" : "";
  return `${LEVEL_EMOJI[transition.to]} <b>${symbol}</b> ${quotaName}: ${transition.pct.toFixed(1)}% of ${directionLabel} cap${suffix}`;
}

// Telegram rejects messages over 4096 characters; one mass-escalation event
// (channel_value repricing at window rollover can move every path at once)
// must not produce an oversized — and therefore permanently failing — batch.
// Pure and exported for tests.
export const TELEGRAM_MAX_LEN = 4096;
export function chunkTelegramText(header: string, lines: string[]): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current.length + 1 + line.length > TELEGRAM_MAX_LEN) {
      chunks.push(current);
      current = header;
    }
    // A single line that can never fit is truncated rather than wedging the
    // whole batch (not expected: lines are ~100 chars).
    const room = TELEGRAM_MAX_LEN - current.length - 1;
    current += `\n${line.length > room ? line.slice(0, Math.max(0, room)) : line}`;
  }
  chunks.push(current);
  return chunks;
}

// Low-level Telegram delivery for ONE message. Returns false (after logging
// the content) when the bot env vars are not configured; throws on delivery
// failure.
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    logger.warn(`Telegram not configured; message:\n${text}`);
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

// Send the run's transitions as one batched message (chunked only when a mass
// event exceeds Telegram's length cap). Throws on delivery failure so the
// caller can skip persisting alert states and retry next run.
export async function sendTelegramAlerts(
  transitions: AlertTransition[]
): Promise<boolean> {
  const chunks = chunkTelegramText(
    "<b>Osmosis IBC rate limits</b>",
    transitions.map(describe)
  );
  let delivered = false;
  for (const chunk of chunks) {
    delivered = (await sendTelegramMessage(chunk)) || delivered;
  }
  return delivered;
}
