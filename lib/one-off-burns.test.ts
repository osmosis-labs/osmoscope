import { test } from "node:test";
import assert from "node:assert/strict";
import { recurringBurned } from "./one-off-burns";

const BURNS = [
  { time: "2026-10-10T02:00:00Z", height: 1, amount: 16_000_000, label: "x" },
];

test("recurringBurned: a one-off burn drops out of the delta, the day's recurring burn stays", () => {
  const before = {
    timestamp: "2026-10-09T17:16:00Z",
    burnedSupply: 27_000_000,
  };
  const after = { timestamp: "2026-10-10T17:16:00Z", burnedSupply: 43_050_000 };
  assert.equal(
    recurringBurned(after, BURNS) - recurringBurned(before, BURNS),
    50_000
  );
});

test("recurringBurned: a missing snapshot day still excludes the burn from the spanning delta", () => {
  const before = {
    timestamp: "2026-10-08T17:16:00Z",
    burnedSupply: 27_000_000,
  };
  const after = { timestamp: "2026-10-11T17:16:00Z", burnedSupply: 43_090_000 };
  assert.equal(
    recurringBurned(after, BURNS) - recurringBurned(before, BURNS),
    90_000
  );
});
