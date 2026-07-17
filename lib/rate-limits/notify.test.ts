// Locks the delivery semantics: per-channel escaping, batch chunking, the
// at-least-once dispatcher rule (one configured channel failing holds back
// state persistence), and single-channel ops-notice routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkLines,
  dispatchAlerts,
  escapeHtml,
  escapeMrkdwn,
  parseTelegramChatIds,
  sendOpsNotice,
  type AlertChannel,
} from "./notify";
import type { AlertTransition } from "./alerts";

const transition = (over: Partial<AlertTransition> = {}): AlertTransition => ({
  pathKey: "any|uosmo|DAY",
  symbol: "OSMO",
  quotaName: "DAY",
  direction: "out",
  pct: 96.2,
  from: "warn",
  to: "urgent",
  ...over,
});

function mockChannel(over: Partial<AlertChannel> = {}): AlertChannel & {
  sent: AlertTransition[][];
  notices: string[];
} {
  const sent: AlertTransition[][] = [];
  const notices: string[] = [];
  return {
    name: "mock",
    configured: () => true,
    async sendAlerts(t) {
      sent.push(t);
    },
    async sendNotice(title, body) {
      notices.push(`${title}|${body}`);
    },
    sent,
    notices,
    ...over,
  };
}

test("escapeHtml and escapeMrkdwn cover the reserved characters", () => {
  assert.equal(escapeHtml("A&B <t>"), "A&amp;B &lt;t&gt;");
  assert.equal(escapeMrkdwn("A&B <t>"), "A&amp;B &lt;t&gt;");
});

test("parseTelegramChatIds: comma list with whitespace and empties", () => {
  assert.deepEqual(parseTelegramChatIds("123456789"), ["123456789"]);
  assert.deepEqual(parseTelegramChatIds(" 123, -1009876,  ,42 ,"), [
    "123",
    "-1009876",
    "42",
  ]);
  assert.deepEqual(parseTelegramChatIds(undefined), []);
  assert.deepEqual(parseTelegramChatIds("  "), []);
});

test("chunkLines splits under the cap with the header repeated", () => {
  const lines = Array.from(
    { length: 10 },
    (_, i) => `line-${i}-${"x".repeat(30)}`
  );
  const chunks = chunkLines("HDR", lines, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 100);
    assert.ok(c.startsWith("HDR"));
  }
  // Every line survives, none dropped.
  const joined = chunks.join("\n");
  for (const l of lines) assert.ok(joined.includes(l));
});

test("dispatcher sends to every configured channel", async () => {
  const a = mockChannel({ name: "a" });
  const b = mockChannel({ name: "b" });
  const result = await dispatchAlerts([transition()], [a, b]);
  assert.deepEqual(result, { anyConfigured: true, delivered: true });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
});

test("dispatcher skips unconfigured channels and reports log-only mode", async () => {
  const off = mockChannel({ name: "off", configured: () => false });
  const result = await dispatchAlerts([transition()], [off]);
  assert.deepEqual(result, { anyConfigured: false, delivered: false });
  assert.equal(off.sent.length, 0);
});

test("dispatcher throws when ANY configured channel fails (at-least-once)", async () => {
  const good = mockChannel({ name: "good" });
  const bad = mockChannel({
    name: "bad",
    async sendAlerts() {
      throw new Error("webhook 500");
    },
  });
  await assert.rejects(
    () => dispatchAlerts([transition()], [good, bad]),
    /bad: webhook 500/
  );
  // The good channel still delivered (duplicates beat silent loss).
  assert.equal(good.sent.length, 1);
});

test("ops notice goes to the FIRST configured channel only", async () => {
  const off = mockChannel({ name: "off", configured: () => false });
  const first = mockChannel({ name: "first" });
  const second = mockChannel({ name: "second" });
  await sendOpsNotice("Degraded", "details", [off, first, second]);
  assert.equal(first.notices.length, 1);
  assert.equal(second.notices.length, 0);
});
