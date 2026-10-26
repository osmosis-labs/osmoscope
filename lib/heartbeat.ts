// Liveness check for the IBC rate-limit monitor, run by the Worker's cron
// trigger (worker.ts `scheduled`). The monitor itself runs on GitHub Actions,
// which can drop scheduled runs or disable them after 60 days without repo
// activity; it only reports trouble from a run that executes. This check runs
// on Cloudflare instead, so it still fires when the Actions schedule stops.
//
// Every monitor run refreshes the stored snapshot that /api/rate-limits
// serves, so its timestamp is the heartbeat. The check keeps no state: cron
// triggers run in whichever data centre has capacity, so per-location storage
// such as the Cache API would lose or repeat notices. Instead the trigger
// fires on fixed half-hour slots, and a notice goes out on exactly one slot
// per RENOTIFY window, worked out from the snapshot's age (or, when the age
// is unknown, from the slot time itself). The all-clear comes from the
// monitor: its first run after a gap says it resumed (cron/rate-limits).
//
// Self-contained (plain fetch, no app imports) because worker.ts bundles it
// beside the OpenNext build.

// The trigger cadence (wrangler.jsonc "*/30 * * * *").
export const HEARTBEAT_INTERVAL_MS = 30 * 60_000;
// Six missed 15-minute monitor runs. GitHub routinely drops every scheduled
// run for about an hour around 00:00 UTC (and sometimes at other busy times),
// so a shorter limit would page for those gaps every night.
export const HEARTBEAT_MAX_AGE_MS = 90 * 60_000;
// While the monitor stays down, repeat the notice this often.
export const HEARTBEAT_RENOTIFY_MS = 6 * 60 * 60_000;

export type HeartbeatStatus =
  | { ok: true; ageMs: number }
  | { ok: false; ageMs: number | null; reason: string };

// Judge the /api/rate-limits response: stale, unreadable or missing data all
// count as the monitor being down.
export function evaluateFreshness(
  status: number,
  body: unknown,
  nowMs: number
): HeartbeatStatus {
  if (status !== 200) {
    return {
      ok: false,
      ageMs: null,
      reason: `/api/rate-limits answered HTTP ${status}`,
    };
  }
  const ts = (body as { current?: { timestamp?: unknown } } | null)?.current
    ?.timestamp;
  const at = typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      ageMs: null,
      reason: "the stored snapshot has no timestamp",
    };
  }
  const ageMs = nowMs - at;
  if (ageMs > HEARTBEAT_MAX_AGE_MS) {
    const minutes = Math.round(ageMs / 60_000);
    return {
      ok: false,
      ageMs,
      reason: `the last monitor run was ${minutes} minutes ago (${ts})`,
    };
  }
  return { ok: true, ageMs };
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

// Whether this slot sends the outage notice. With a known age, the slot
// where the age first passes MAX_AGE, then one slot every RENOTIFY window;
// slots are INTERVAL apart, so exactly one falls in each window. With an
// unknown age, the slots at the start of each RENOTIFY window of the day
// (00:00, 06:00, 12:00 and 18:00 UTC).
export function isNoticeSlot(status: HeartbeatStatus, slotMs: number): boolean {
  if (status.ok) return false;
  const slotsPerWindow = HEARTBEAT_RENOTIFY_MS / HEARTBEAT_INTERVAL_MS;
  if (status.ageMs == null) {
    return mod(slotMs, HEARTBEAT_RENOTIFY_MS) < HEARTBEAT_INTERVAL_MS;
  }
  // Slot 1 is the first slot past MAX_AGE (the age then lies in
  // (MAX_AGE, MAX_AGE + INTERVAL]); every slotsPerWindow-th slot after it
  // repeats the notice. Counting slots, not taking a remainder, keeps an
  // age that lands exactly on a slot boundary from skipping a window.
  const slot = Math.ceil(
    (status.ageMs - HEARTBEAT_MAX_AGE_MS) / HEARTBEAT_INTERVAL_MS
  );
  return slot >= 1 && mod(slot - 1, slotsPerWindow) === 0;
}

// Whether a gap between monitor runs, from lastMs to nowMs, was long enough
// for the heartbeat to send its outage notice: some trigger slot fell after
// the snapshot passed MAX_AGE and before the run at nowMs refreshed it. The
// monitor sends its "resumed" notice only then, so every all-clear follows
// an outage notice.
export function heartbeatNoticedGap(lastMs: number, nowMs: number): boolean {
  const firstStaleSlot =
    (Math.floor((lastMs + HEARTBEAT_MAX_AGE_MS) / HEARTBEAT_INTERVAL_MS) + 1) *
    HEARTBEAT_INTERVAL_MS;
  return firstStaleSlot < nowMs;
}

export type HeartbeatEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  SLACK_WEBHOOK_URL?: string;
  // Set to "1" to silence the heartbeat while the monitor is paused on
  // purpose (the CRON_RUNNER Actions variable unset).
  HEARTBEAT_PAUSED?: string;
};

// The ops target, as lib/rate-limits/notify.ts picks it: the FIRST configured
// channel (Telegram's first chat id, else Slack).
export function opsTarget(
  env: HeartbeatEnv
):
  | { kind: "telegram"; token: string; chatId: string }
  | { kind: "slack"; url: string }
  | null {
  const chatId = (env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (env.TELEGRAM_BOT_TOKEN && chatId) {
    return { kind: "telegram", token: env.TELEGRAM_BOT_TOKEN, chatId };
  }
  if (env.SLACK_WEBHOOK_URL)
    return { kind: "slack", url: env.SLACK_WEBHOOK_URL };
  return null;
}

export async function sendNotice(
  env: HeartbeatEnv,
  text: string,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  const target = opsTarget(env);
  if (!target) {
    console.warn(`Heartbeat: no alert channel configured; ${text}`);
    return false;
  }
  const response =
    target.kind === "telegram"
      ? await fetchFn(
          `https://api.telegram.org/bot${target.token}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: target.chatId, text }),
          }
        )
      : await fetchFn(target.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
  if (!response.ok) {
    // Status only: the URL carries the bot token.
    console.error(
      `Heartbeat: ${target.kind} notice failed: ${response.status}`
    );
    return false;
  }
  return true;
}

// One heartbeat run, at the trigger's scheduled slot time.
export async function runHeartbeat(opts: {
  fetchSnapshot: () => Promise<Response>;
  env: HeartbeatEnv;
  slotMs: number;
  fetchFn?: typeof fetch;
}): Promise<"ok" | "paused" | "notified" | "notice failed" | "down"> {
  if (opts.env.HEARTBEAT_PAUSED === "1") return "paused";

  let status: HeartbeatStatus;
  try {
    const response = await opts.fetchSnapshot();
    const body = response.ok ? await response.json().catch(() => null) : null;
    status = evaluateFreshness(response.status, body, opts.slotMs);
  } catch (error) {
    status = {
      ok: false,
      ageMs: null,
      reason: `/api/rate-limits failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (status.ok) return "ok";
  if (!isNoticeSlot(status, opts.slotMs)) return "down";

  const sent = await sendNotice(
    opts.env,
    `OSMOscope rate-limit monitor is not running: ${status.reason}. IBC rate-limit trip alerts are paused until it recovers; the monitor posts when it resumes.`,
    opts.fetchFn
  );
  return sent ? "notified" : "notice failed";
}
