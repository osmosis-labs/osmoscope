// The heartbeat exists to say the rate-limit monitor has stopped. It keeps no
// state (cron triggers move between data centres), so the slot arithmetic is
// what guarantees one notice per outage window: never every 30 minutes,
// never none.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFreshness,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_AGE_MS,
  HEARTBEAT_RENOTIFY_MS,
  heartbeatNoticedGap,
  isNoticeSlot,
  opsTarget,
  runHeartbeat,
} from "./heartbeat";

const SLOT = Date.parse("2026-10-22T12:00:00Z");
const ENV = { TELEGRAM_BOT_TOKEN: "t0ken", TELEGRAM_CHAT_ID: "111,222" };

const snapshotAt = (ms: number) =>
  new Response(
    JSON.stringify({ current: { timestamp: new Date(ms).toISOString() } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

function recorder(status = 200) {
  const sent: { url: string; body: string }[] = [];
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { sent, fetchFn };
}

test("evaluateFreshness: fresh, stale, missing and failed", () => {
  const fresh = evaluateFreshness(
    200,
    { current: { timestamp: new Date(SLOT - 60_000).toISOString() } },
    SLOT
  );
  assert.equal(fresh.ok, true);
  const stale = evaluateFreshness(
    200,
    {
      current: {
        timestamp: new Date(SLOT - HEARTBEAT_MAX_AGE_MS - 60_000).toISOString(),
      },
    },
    SLOT
  );
  assert.equal(stale.ok, false);
  assert.equal(evaluateFreshness(200, {}, SLOT).ok, false);
  assert.equal(evaluateFreshness(503, null, SLOT).ok, false);
});

test("an outage seen slot by slot notices once per window", () => {
  // The monitor's last run was at some offset; the heartbeat samples every
  // half hour for 15 hours. Try offsets including exact slot boundaries.
  for (const offsetMin of [0, 1, 7, 15, 29, 30]) {
    const lastRun = SLOT - offsetMin * 60_000;
    const notices: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const slot = SLOT + i * HEARTBEAT_INTERVAL_MS;
      const ageMs = slot - lastRun;
      const status =
        ageMs > HEARTBEAT_MAX_AGE_MS
          ? { ok: false as const, ageMs, reason: "stale" }
          : { ok: true as const, ageMs };
      if (isNoticeSlot(status, slot)) notices.push(ageMs / 60_000);
    }
    assert.equal(notices.length, 3, `offset ${offsetMin}: ${notices}`);
    const maxAgeMin = HEARTBEAT_MAX_AGE_MS / 60_000;
    const intervalMin = HEARTBEAT_INTERVAL_MS / 60_000;
    assert.ok(
      notices[0] > maxAgeMin && notices[0] <= maxAgeMin + intervalMin,
      `first notice ${notices[0]}`
    );
    assert.equal(notices[1] - notices[0], HEARTBEAT_RENOTIFY_MS / 60_000);
  }
});

test("an unknown age notices on the 00:00/06:00/12:00/18:00 UTC slots", () => {
  const status = { ok: false as const, ageMs: null, reason: "HTTP 500" };
  const noticed = [];
  for (let i = 0; i < 48; i++) {
    const slot = Date.parse("2026-10-22T00:00:00Z") + i * HEARTBEAT_INTERVAL_MS;
    if (isNoticeSlot(status, slot))
      noticed.push(new Date(slot).toISOString().slice(11, 16));
  }
  assert.deepEqual(noticed, ["00:00", "06:00", "12:00", "18:00"]);
});

test("GitHub's nightly dropped runs neither warn nor send an all-clear", () => {
  // Gaps between completed runs seen 2026-10-24..26: GitHub started no
  // scheduled run from about 23:54 to 00:54 UTC.
  for (const [last, next] of [
    ["2026-10-23T23:54:38Z", "2026-10-24T00:48:59Z"],
    ["2026-10-24T23:54:49Z", "2026-10-25T00:55:10Z"],
    ["2026-10-25T23:54:40Z", "2026-10-26T00:53:44Z"],
    ["2026-10-26T05:58:30Z", "2026-10-26T06:46:20Z"],
  ]) {
    const lastMs = Date.parse(last);
    const nextMs = Date.parse(next);
    assert.equal(heartbeatNoticedGap(lastMs, nextMs), false, last);
    // No heartbeat slot inside the gap sees the snapshot as stale.
    for (
      let slot =
        Math.ceil(lastMs / HEARTBEAT_INTERVAL_MS) * HEARTBEAT_INTERVAL_MS;
      slot < nextMs;
      slot += HEARTBEAT_INTERVAL_MS
    ) {
      const body = { current: { timestamp: new Date(lastMs).toISOString() } };
      assert.equal(evaluateFreshness(200, body, slot).ok, true, last);
    }
  }
});

test("heartbeatNoticedGap matches the heartbeat's first outage notice", () => {
  // For a range of last-run times and gap lengths, the monitor says it
  // resumed exactly when some slot inside the gap sent the outage notice.
  for (let offsetMin = 0; offsetMin < 30; offsetMin += 1) {
    const lastMs = SLOT + offsetMin * 60_000;
    for (let gapMin = 1; gapMin <= 180; gapMin++) {
      const nextMs = lastMs + gapMin * 60_000;
      let noticed = false;
      for (
        let slot =
          Math.ceil(lastMs / HEARTBEAT_INTERVAL_MS) * HEARTBEAT_INTERVAL_MS;
        slot < nextMs;
        slot += HEARTBEAT_INTERVAL_MS
      ) {
        const status = evaluateFreshness(
          200,
          { current: { timestamp: new Date(lastMs).toISOString() } },
          slot
        );
        if (isNoticeSlot(status, slot)) noticed = true;
      }
      assert.equal(
        heartbeatNoticedGap(lastMs, nextMs),
        noticed,
        `offset ${offsetMin}, gap ${gapMin}`
      );
    }
  }
});

test("opsTarget: the first Telegram chat, else Slack, else none", () => {
  assert.deepEqual(opsTarget(ENV), {
    kind: "telegram",
    token: "t0ken",
    chatId: "111",
  });
  assert.deepEqual(opsTarget({ SLACK_WEBHOOK_URL: "https://hooks" }), {
    kind: "slack",
    url: "https://hooks",
  });
  assert.equal(opsTarget({}), null);
});

test("runHeartbeat: healthy, paused, notice slot and a quiet slot", async () => {
  const { sent, fetchFn } = recorder();
  const fresh = () => Promise.resolve(snapshotAt(SLOT - 5 * 60_000));
  assert.equal(
    await runHeartbeat({
      fetchSnapshot: fresh,
      env: ENV,
      slotMs: SLOT,
      fetchFn,
    }),
    "ok"
  );

  const firstSlotStale = () =>
    Promise.resolve(snapshotAt(SLOT - HEARTBEAT_MAX_AGE_MS - 5 * 60_000));
  assert.equal(
    await runHeartbeat({
      fetchSnapshot: firstSlotStale,
      env: { ...ENV, HEARTBEAT_PAUSED: "1" },
      slotMs: SLOT,
      fetchFn,
    }),
    "paused"
  );
  assert.equal(sent.length, 0);

  assert.equal(
    await runHeartbeat({
      fetchSnapshot: firstSlotStale,
      env: ENV,
      slotMs: SLOT,
      fetchFn,
    }),
    "notified"
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /not running/);
  assert.match(sent[0].body, /"chat_id":"111"/);

  const laterStale = () =>
    Promise.resolve(snapshotAt(SLOT - HEARTBEAT_MAX_AGE_MS - 35 * 60_000));
  assert.equal(
    await runHeartbeat({
      fetchSnapshot: laterStale,
      env: ENV,
      slotMs: SLOT,
      fetchFn,
    }),
    "down"
  );
  assert.equal(sent.length, 1);
});

test("a failed notice send is reported and never logs the bot token", async () => {
  const logged: string[] = [];
  const origError = console.error;
  console.error = (m: string) => logged.push(m);
  const { fetchFn } = recorder(500);
  let result;
  try {
    result = await runHeartbeat({
      fetchSnapshot: () => Promise.reject(new Error("db down")),
      env: ENV,
      slotMs: Date.parse("2026-10-22T06:00:00Z"),
      fetchFn,
    });
  } finally {
    console.error = origError;
  }
  assert.equal(result, "notice failed");
  assert.ok(
    logged.every((m) => !m.includes("t0ken")),
    "the bot token is never logged"
  );
});
