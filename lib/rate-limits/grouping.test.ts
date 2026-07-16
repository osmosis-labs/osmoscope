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
