// Locks the binding-window semantics the card headlines: the window with the
// LEAST absolute capacity remaining wins, not the highest percentage — a
// small-cap Day window at a lower % can still be the first to block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssetGroups, remainingBase } from "./grouping";
import type { PathUtilization, WindowUtilization } from "./snapshot";

function window(
  overrides: Partial<WindowUtilization> & { quotaName: string }
): WindowUtilization {
  return {
    durationSeconds: 86_400,
    sendPct: 10,
    recvPct: 10,
    channelValue: "1000",
    inflow: "0",
    outflow: "0",
    periodEnd: "9999999999999999999",
    windowActive: true,
    utilizationPct: 0,
    direction: "in",
    ...overrides,
  };
}

function path(
  denom: string,
  symbol: string,
  windows: WindowUtilization[]
): PathUtilization {
  const utils = windows
    .map((w) => w.utilizationPct)
    .filter((p): p is number => p != null);
  return {
    channel: "any",
    denom,
    symbol,
    windows,
    maxUtilizationPct: utils.length ? Math.max(...utils) : null,
  };
}

test("remainingBase: cap minus net flow in the binding direction", () => {
  // channelValue 1000, recv cap 5% → 50; net inflow 20 → remaining 30.
  const w = window({
    quotaName: "DAY",
    recvPct: 5,
    inflow: "20",
    outflow: "0",
    utilizationPct: 40,
    direction: "in",
  });
  assert.equal(remainingBase(w), 30);
});

test("remainingBase: null for expired/closed windows", () => {
  assert.equal(
    remainingBase(
      window({ quotaName: "X", utilizationPct: null, direction: null })
    ),
    null
  );
});

test("binding window = least absolute remaining, not highest percentage", () => {
  // DAY: cap 50 (5% of 1000), used 20 → 40% utilized, remaining 30.
  // WEEK: cap 200 (20% of 1000), used 120 → 60% utilized, remaining 80.
  // WEEK has the higher %, but DAY blocks first (30 < 80) — DAY must headline.
  const day = window({
    quotaName: "DAY-1",
    recvPct: 5,
    inflow: "20",
    utilizationPct: 40,
  });
  const week = window({
    quotaName: "WEEK-1",
    durationSeconds: 604_800,
    recvPct: 20,
    inflow: "120",
    utilizationPct: 60,
  });
  const [group] = buildAssetGroups([path("uosmo", "OSMO", [day, week])]);
  assert.equal(group.binding?.window.quotaName, "DAY-1");
  assert.equal(group.binding?.remaining, 30);
});

test("ranking: tightest binding percentage first, quiet assets last alphabetically", () => {
  const busy = path("ibc/busy", "BUSY", [
    window({ quotaName: "D", inflow: "90", recvPct: 10, utilizationPct: 90 }),
  ]);
  const calm = path("ibc/calm", "CALM", [
    window({ quotaName: "D", inflow: "10", recvPct: 10, utilizationPct: 10 }),
  ]);
  const quietB = path("ibc/qb", "BETA", [
    window({ quotaName: "D", utilizationPct: null, direction: null }),
  ]);
  const quietA = path("ibc/qa", "ALPHA", [
    window({ quotaName: "D", utilizationPct: null, direction: null }),
  ]);
  const ranked = buildAssetGroups([quietB, calm, busy, quietA]);
  assert.deepEqual(
    ranked.map((g) => g.symbol),
    ["BUSY", "CALM", "ALPHA", "BETA"]
  );
  assert.equal(ranked[2].binding, null);
});

test("near-tie on remaining (within 10%): longest reset time wins", () => {
  // Remaining 95 vs 100 — within 10% of each other, so the DAY window's
  // smaller headroom does NOT win outright; WEEK resets later and surfaces.
  const day = window({
    quotaName: "DAY",
    channelValue: "1000",
    recvPct: 10,
    inflow: "5",
    utilizationPct: 5,
    periodEnd: "1000000000000000000",
  });
  const week = window({
    quotaName: "WEEK",
    durationSeconds: 604_800,
    channelValue: "1000",
    recvPct: 10,
    inflow: "0",
    utilizationPct: 0,
    periodEnd: "2000000000000000000",
  });
  const [group] = buildAssetGroups([path("uosmo", "OSMO", [day, week])]);
  assert.equal(group.binding?.window.quotaName, "WEEK");
});

test("clear gap in remaining (>10%): least remaining wins regardless of reset", () => {
  const tight = window({
    quotaName: "DAY",
    channelValue: "1000",
    recvPct: 10,
    inflow: "50", // remaining 50
    utilizationPct: 50,
    periodEnd: "1000000000000000000", // resets sooner
  });
  const loose = window({
    quotaName: "WEEK",
    durationSeconds: 604_800,
    channelValue: "1000",
    recvPct: 10,
    inflow: "0", // remaining 100
    utilizationPct: 0,
    periodEnd: "2000000000000000000", // resets later
  });
  const [group] = buildAssetGroups([path("uosmo", "OSMO", [tight, loose])]);
  assert.equal(group.binding?.window.quotaName, "DAY");
});

test("both windows fully blocked (0 remaining): longest reset surfaces", () => {
  const shortBlock = window({
    quotaName: "DAY",
    channelValue: "1000",
    recvPct: 10,
    inflow: "100",
    utilizationPct: 100,
    periodEnd: "1000000000000000000",
  });
  const longBlock = window({
    quotaName: "WEEK",
    durationSeconds: 604_800,
    channelValue: "1000",
    recvPct: 10,
    inflow: "100",
    utilizationPct: 100,
    periodEnd: "2000000000000000000",
  });
  const [group] = buildAssetGroups([
    path("uosmo", "OSMO", [shortBlock, longBlock]),
  ]);
  assert.equal(group.binding?.window.quotaName, "WEEK");
});

test("multiple paths of one denom fold into one group", () => {
  const a = path("uosmo", "OSMO", [
    window({ quotaName: "D", inflow: "10", recvPct: 10, utilizationPct: 10 }),
  ]);
  const b = {
    ...path("uosmo", "OSMO", [
      window({ quotaName: "W", inflow: "95", recvPct: 10, utilizationPct: 95 }),
    ]),
    channel: "channel-0",
  };
  const ranked = buildAssetGroups([a, b]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].paths.length, 2);
  // channel-0's window has remaining 5 vs 90 — it binds.
  assert.equal(ranked[0].binding?.window.quotaName, "W");
});
