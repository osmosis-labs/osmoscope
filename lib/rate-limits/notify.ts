// Alert delivery for the rate-limit monitor: a channel abstraction with
// Telegram (bot API, HTML formatting) and Slack (incoming webhook, mrkdwn)
// transports behind one dispatcher.
//
// Semantics, decided deliberately:
//   - Every TRIP alert goes to every configured channel.
//   - Delivery is at-least-once: the dispatcher throws if ANY configured
//     channel fails, so the caller skips persisting alert states and the same
//     transitions re-fire next run. A duplicate message on the channel that
//     did deliver is acceptable; silently losing an alert on the other is not.
//   - With NO channel configured the monitor degrades to a log-only checker
//     (content logged, states still advance — otherwise an unconfigured
//     deploy would re-log the same transitions forever).
//   - OPS notices (monitor degraded etc.) go to ONE channel only — the first
//     configured of [Telegram, Slack] — so infrastructure noise doesn't page
//     every channel that carries trip alerts.
import { logger } from "../logger";
import { WARN_PCT, type AlertTransition } from "./alerts";

// ---------------------------------------------------------------------------
// Escaping + chunking (pure, exported for tests)
// ---------------------------------------------------------------------------

// Symbols and quota names come from external data (the assetlist, contract
// state); one unescaped `&` or `<` would make the receiving API reject the
// message — permanently, since delivery failure blocks state persistence and
// the identical batch retries forever. Escape at the boundary, per channel's
// own rules.
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Slack mrkdwn only reserves these three (https://api.slack.com/reference/surfaces/formatting).
export function escapeMrkdwn(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Split a batch under a per-message length cap so one mass-escalation event
// (channel_value repricing at window rollover can move every path at once)
// can't produce an oversized — and therefore permanently failing — message.
export function chunkLines(
  header: string,
  lines: string[],
  maxLen: number
): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current.length + 1 + line.length > maxLen) {
      chunks.push(current);
      current = header;
    }
    // A single line that can never fit is truncated rather than wedging the
    // whole batch (not expected: lines are ~100 chars).
    const room = maxLen - current.length - 1;
    current += `\n${line.length > room ? line.slice(0, Math.max(0, room)) : line}`;
  }
  chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// Per-channel line formatting
// ---------------------------------------------------------------------------

const LEVEL_EMOJI: Record<string, string> = {
  warn: "⚠️",
  urgent: "🚨",
  blocking: "⛔",
};

function directionLabel(t: AlertTransition): string {
  return t.direction === "out"
    ? "outflow"
    : t.direction === "in"
      ? "inflow"
      : "flow";
}

function describeWith(
  t: AlertTransition,
  escape: (s: string) => string,
  bold: (s: string) => string
): string {
  const symbol = bold(escape(t.symbol));
  const quotaName = escape(t.quotaName);
  if (t.to === null) {
    return `✅ ${symbol} ${quotaName}: back below ${WARN_PCT}%`;
  }
  const suffix = t.to === "blocking" ? " — transfers blocked" : "";
  return `${LEVEL_EMOJI[t.to]} ${symbol} ${quotaName}: ${t.pct.toFixed(1)}% of ${directionLabel(t)} cap${suffix}`;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface AlertChannel {
  name: string;
  configured(): boolean;
  // Throws on delivery failure so the dispatcher can hold back state
  // persistence (at-least-once).
  sendAlerts(transitions: AlertTransition[]): Promise<void>;
  sendNotice(title: string, body: string): Promise<void>;
}

const TELEGRAM_MAX_LEN = 4096;
// Plain-text webhook posts cap far higher, but chunk near Slack's block-text
// limit anyway for readability.
const SLACK_MAX_LEN = 3900;

async function postTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
}

export const telegramChannel: AlertChannel = {
  name: "telegram",
  configured: () =>
    !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  async sendAlerts(transitions) {
    const lines = transitions.map((t) =>
      describeWith(t, escapeHtml, (s) => `<b>${s}</b>`)
    );
    for (const chunk of chunkLines(
      "<b>Osmosis IBC rate limits</b>",
      lines,
      TELEGRAM_MAX_LEN
    )) {
      await postTelegram(chunk);
    }
  },
  async sendNotice(title, body) {
    await postTelegram(`🛑 <b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`);
  },
};

async function postSlack(text: string): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const response = await fetch(webhook as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Slack send failed: ${response.status} ${detail}`);
  }
}

export const slackChannel: AlertChannel = {
  name: "slack",
  configured: () => !!process.env.SLACK_WEBHOOK_URL,
  async sendAlerts(transitions) {
    const lines = transitions.map((t) =>
      describeWith(t, escapeMrkdwn, (s) => `*${s}*`)
    );
    for (const chunk of chunkLines(
      "*Osmosis IBC rate limits*",
      lines,
      SLACK_MAX_LEN
    )) {
      await postSlack(chunk);
    }
  },
  async sendNotice(title, body) {
    await postSlack(`🛑 *${escapeMrkdwn(title)}*\n${escapeMrkdwn(body)}`);
  },
};

const DEFAULT_CHANNELS: AlertChannel[] = [telegramChannel, slackChannel];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Send the run's transitions to every configured channel. Returns whether any
// channel is configured and delivered; throws if a configured channel failed
// (the caller must then NOT advance alert states). `channels` is injectable
// for tests.
export async function dispatchAlerts(
  transitions: AlertTransition[],
  channels: AlertChannel[] = DEFAULT_CHANNELS
): Promise<{ anyConfigured: boolean; delivered: boolean }> {
  const configured = channels.filter((c) => c.configured());
  if (configured.length === 0) {
    const preview = transitions
      .map((t) =>
        describeWith(
          t,
          (s) => s,
          (s) => s
        )
      )
      .join("\n");
    logger.warn(`No alert channel configured; rate-limit alerts:\n${preview}`);
    return { anyConfigured: false, delivered: false };
  }

  const failures: string[] = [];
  for (const channel of configured) {
    try {
      await channel.sendAlerts(transitions);
    } catch (e) {
      failures.push(
        `${channel.name}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  if (failures.length > 0) {
    // At-least-once across ALL channels: one failure holds back state
    // persistence so the batch re-fires everywhere next run.
    throw new Error(`Alert delivery failed on ${failures.join("; ")}`);
  }
  return { anyConfigured: true, delivered: true };
}

// Ops notices go to ONE channel: the first configured, in priority order.
// Throws if that channel's delivery fails (callers treat notices as
// best-effort and catch); no-op with a log when nothing is configured.
export async function sendOpsNotice(
  title: string,
  body: string,
  channels: AlertChannel[] = DEFAULT_CHANNELS
): Promise<void> {
  const target = channels.find((c) => c.configured());
  if (!target) {
    logger.warn(`No alert channel configured; ops notice: ${title}: ${body}`);
    return;
  }
  await target.sendNotice(title, body);
}
