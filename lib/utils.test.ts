// Monthly x-axis ticks for the wide chart ranges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChartDate, makeMonthlyTicks } from "./utils";

function dailySeries(fromIso: string, days: number) {
  const start = Date.parse(fromIso);
  const timestamps = Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString()
  );
  const labels = timestamps.map((t) => formatChartDate(t, "1y"));
  return { labels, timestamps };
}

test("one tick per calendar month on wide ranges", () => {
  const { labels, timestamps } = dailySeries("2026-01-01T12:00:00Z", 90);
  assert.deepEqual(makeMonthlyTicks(labels, timestamps, "1y"), [
    labels[0],
    labels[31],
    labels[59],
  ]);
});

test("drops a leading stub month that would overprint the next tick", () => {
  // 1Y window opening on 27 Nov: "Nov" covers only 4 points before "Dec".
  const { labels, timestamps } = dailySeries("2025-11-27T12:00:00Z", 40);
  const ticks = makeMonthlyTicks(labels, timestamps, "1y");
  assert.deepEqual(ticks, [labels[4], labels[35]]);
});

test("keeps a leading partial month that spans enough points", () => {
  const { labels, timestamps } = dailySeries("2025-11-15T12:00:00Z", 30);
  const ticks = makeMonthlyTicks(labels, timestamps, "1y");
  assert.deepEqual(ticks, [labels[0], labels[16]]);
});

test("a lone stub month is kept so the axis is never blank", () => {
  const { labels, timestamps } = dailySeries("2025-11-28T12:00:00Z", 3);
  assert.deepEqual(makeMonthlyTicks(labels, timestamps, "1y"), [labels[0]]);
});

test("short ranges and empty series use default ticks", () => {
  const { labels, timestamps } = dailySeries("2026-01-01T12:00:00Z", 30);
  assert.equal(makeMonthlyTicks(labels, timestamps, "90d"), undefined);
  assert.equal(makeMonthlyTicks([], [], "all"), undefined);
});
