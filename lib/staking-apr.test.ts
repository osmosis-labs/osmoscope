import { test } from "node:test";
import assert from "node:assert/strict";
import { aprByDate, trailingAprAverage, shiftDate } from "./staking-apr";

// Numia's real response order: newest first, each day under OSMO and total.
const newestFirst = [
  { labels: "2026-10-15 00:00:00.000", symbol: "OSMO", apr: 4.1 },
  { labels: "2026-10-15 00:00:00.000", symbol: "total", apr: 4.1 },
  { labels: "2026-10-14 00:00:00.000", symbol: "total", apr: 4.0 },
  { labels: "2026-10-14 00:00:00.000", symbol: "OSMO", apr: 4.0 },
  { labels: "2026-09-15 00:00:00.000", symbol: "OSMO", apr: 4.5 },
];

test("aprByDate keys by date regardless of response order", () => {
  const byDate = aprByDate(newestFirst);
  assert.equal(byDate.get("2026-10-15"), 4.1);
  assert.equal(byDate.get("2026-09-15"), 4.5);
  assert.equal(byDate.size, 3);
});

test("trailingAprAverage covers D-30..D inclusive and refuses a partial window", () => {
  const full = new Map<string, number>();
  for (let i = 0; i <= 30; i++) full.set(shiftDate("2026-10-15", -i), i);
  // 0..30 averages to 15; D-31 must not be counted.
  full.set(shiftDate("2026-10-15", -31), 1000);
  assert.equal(trailingAprAverage(full, "2026-10-15"), 15);

  // An outage that returned only the last few days leaves the average unset.
  assert.equal(
    trailingAprAverage(aprByDate(newestFirst), "2026-10-15"),
    undefined
  );
});
