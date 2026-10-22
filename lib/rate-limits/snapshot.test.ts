// Locks the two-bound utilization semantics of contract 0.2.0: percentage
// bounds against the NET flow, absolute bounds against the GROSS flow, and
// legacy (0.1.x) entries reading exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWindow } from "./snapshot";
import { remainingBase } from "./grouping";
import type { ContractQuota, ContractRateLimit } from "./fetch";

const NOW_MS = 1_700_000_000_000;
const ACTIVE_END = "9999999999999999999";

function limit(
  quota: Partial<ContractQuota>,
  flow: { inflow: string; outflow: string }
): ContractRateLimit {
  return {
    quota: {
      name: "DAY",
      max_percentage_send: 10,
      max_percentage_recv: 10,
      duration: 86_400,
      channel_value: "1000",
      ...quota,
    },
    flow: { ...flow, period_end: ACTIVE_END },
  };
}

test("legacy 0.1.x entry: net flow against the percentage cap", () => {
  const w = computeWindow(limit({}, { inflow: "130", outflow: "50" }), NOW_MS);
  assert.equal(w.utilizationPct, 80);
  assert.equal(w.direction, "in");
  assert.equal(w.bound, "percentage");
  assert.equal(w.maxAbsoluteSend, null);
  assert.equal(w.maxAbsoluteRecv, null);
});

test("absolute cap binds on GROSS flow even when the net is zero", () => {
  // Round trip: 90 in, 90 out. Net is 0, so the percentage bound is idle,
  // but the gross outflow has used 90% of the absolute send cap.
  const w = computeWindow(
    limit(
      { max_absolute_send: "100", max_absolute_recv: null },
      { inflow: "90", outflow: "90" }
    ),
    NOW_MS
  );
  assert.equal(w.utilizationPct, 90);
  assert.equal(w.direction, "out");
  assert.equal(w.bound, "absolute");
  assert.equal(remainingBase(w), 10);
});

test("null percentage with an absolute cap needs no channel value", () => {
  const w = computeWindow(
    limit(
      {
        max_percentage_send: null,
        max_percentage_recv: null,
        max_absolute_send: "1000",
        max_absolute_recv: "1000",
        channel_value: "0",
      },
      { inflow: "600", outflow: "0" }
    ),
    NOW_MS
  );
  assert.equal(w.sendPct, null);
  assert.equal(w.utilizationPct, 60);
  assert.equal(w.direction, "in");
  assert.equal(w.bound, "absolute");
});

test("percentage above 100 is not clamped", () => {
  const w = computeWindow(
    limit(
      { max_percentage_recv: 200, max_absolute_recv: "1000000" },
      { inflow: "1000", outflow: "0" }
    ),
    NOW_MS
  );
  // 1000 net of a 2000 percentage cap = 50%; the absolute cap is far away.
  assert.equal(w.utilizationPct, 50);
  assert.equal(w.bound, "percentage");
});

test("remainingBase takes the tighter bound in the binding direction", () => {
  // Percentage cap 100 (10% of 1000) with net 0 leaves 100; absolute cap 150
  // with gross 120 leaves 30.
  const w = computeWindow(
    limit({ max_absolute_recv: "150" }, { inflow: "120", outflow: "120" }),
    NOW_MS
  );
  assert.equal(w.direction, "in");
  assert.equal(remainingBase(w), 30);
});

test("a zero absolute cap closes the direction like a 0% cap", () => {
  const w = computeWindow(
    limit(
      { max_absolute_recv: "0", max_percentage_send: 0 },
      { inflow: "5", outflow: "0" }
    ),
    NOW_MS
  );
  assert.equal(w.utilizationPct, null);
  assert.equal(w.direction, null);
});

test("a cached zero channel value blocks the percentage direction", () => {
  // The percentage cap is 0, so any net inbound transfer fails even though
  // the absolute cap is untouched.
  const w = computeWindow(
    limit(
      { channel_value: "0", max_absolute_recv: "100" },
      { inflow: "0", outflow: "0" }
    ),
    NOW_MS
  );
  assert.equal(w.utilizationPct, 100);
  assert.equal(w.direction, "in");
  assert.equal(w.bound, "percentage");
});

test("a channel value not yet cached stays not computable", () => {
  const w = computeWindow(
    limit({ channel_value: null }, { inflow: "0", outflow: "0" }),
    NOW_MS
  );
  assert.equal(w.utilizationPct, null);
});

test("opposing net flow adds percentage headroom", () => {
  // Percentage cap 100 (10% of 1000), absolute recv cap 200. Gross inflow
  // 150 binds "in" on the absolute cap; net is -50, so the percentage
  // headroom is 150, and the absolute 50 is the tighter.
  const w = computeWindow(
    limit({ max_absolute_recv: "200" }, { inflow: "150", outflow: "200" }),
    NOW_MS
  );
  assert.equal(w.direction, "in");
  assert.equal(remainingBase(w), 50);
  // Without the absolute cap the in-direction percentage headroom would be
  // 150, not the 100 a clamped net would give.
  assert.equal(remainingBase({ ...w, maxAbsoluteRecv: null }), 150);
});
