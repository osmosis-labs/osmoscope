import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aprByDate,
  trailingAprAverage,
  shiftDate,
  NUMIA_APR_OVERRIDES,
} from "./staking-apr";

// Numia's real response order: newest first, each day under OSMO and total.
const newestFirst = [
  { labels: "2026-10-25 00:00:00.000", symbol: "OSMO", apr: 4.1 },
  { labels: "2026-10-25 00:00:00.000", symbol: "total", apr: 4.1 },
  { labels: "2026-10-24 00:00:00.000", symbol: "total", apr: 4.0 },
  { labels: "2026-10-24 00:00:00.000", symbol: "OSMO", apr: 4.0 },
  { labels: "2026-09-25 00:00:00.000", symbol: "OSMO", apr: 4.5 },
];

test("aprByDate keys by date regardless of response order", () => {
  const byDate = aprByDate(newestFirst);
  assert.equal(byDate.get("2026-10-25"), 4.1);
  assert.equal(byDate.get("2026-09-25"), 4.5);
  assert.equal(byDate.size, 3);
});

test("aprByDate replaces overridden days Numia covers, and only those", () => {
  const byDate = aprByDate([
    { labels: "2026-10-15 00:00:00.000", symbol: "OSMO", apr: 4.1 },
    { labels: "2026-10-17 00:00:00.000", symbol: "OSMO", apr: 7.25 },
  ]);
  assert.equal(byDate.get("2026-10-15"), NUMIA_APR_OVERRIDES["2026-10-15"]);
  assert.equal(byDate.get("2026-10-17"), 7.25);
  // An override never invents a day Numia didn't return.
  assert.equal(byDate.has("2026-10-14"), false);
});

test("trailingAprAverage covers D-30..D inclusive and refuses a partial window", () => {
  const full = new Map<string, number>();
  for (let i = 0; i <= 30; i++) full.set(shiftDate("2026-10-25", -i), i);
  // 0..30 averages to 15; D-31 must not be counted.
  full.set(shiftDate("2026-10-25", -31), 1000);
  assert.equal(trailingAprAverage(full, "2026-10-25"), 15);

  // An outage that returned only the last few days leaves the average unset.
  assert.equal(
    trailingAprAverage(aprByDate(newestFirst), "2026-10-25"),
    undefined
  );
});
