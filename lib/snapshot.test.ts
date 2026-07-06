import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSnapshotSane, SnapshotSanityError } from "./snapshot";

// A plausible raw-minted-basis snapshot (~811M total, ~568M circulating), with
// a ~55M dev-vesting offset reversed in. Individual tests override fields.
const DEV_VESTING = 55_000_000;
function baseMetrics(overrides = {}) {
  return {
    mintedSupply: 811_000_000,
    totalSupply: 811_000_000,
    burned: 40_000_000,
    circulating: 568_000_000,
    restrictedSupply: 188_000_000,
    communitySupply: 55_000_000,
    devVestingSupply: DEV_VESTING,
    ...overrides,
  };
}

test("assertSnapshotSane: passes a clean snapshot with no prior row", () => {
  assert.doesNotThrow(() => assertSnapshotSane(baseMetrics()));
});

test("assertSnapshotSane: legacy prev (no devVestingSupply) does NOT trip on the one-time raw-basis shift", () => {
  // The prior row was written on the OFFSET-APPLIED basis, so its totalSupply is
  // ~one dev-vesting balance lower than today's raw-minted total. That gap is a
  // methodology artifact, not a real supply move, and must not trip the gate.
  // Only totalSupply/circulating shifted with the fix. restrictedSupply already
  // included dev-vesting once even pre-fix (restrictedEntities + devVesting), so
  // a legacy row's restrictedSupply is on the SAME basis and needs no normalizing.
  const prev = {
    totalSupply: 811_000_000 - DEV_VESTING, // 756M, offset-applied
    restrictedSupply: 188_000_000, // unchanged basis
    communitySupply: 55_000_000,
    devVestingSupply: null, // legacy row: field absent
  };
  assert.doesNotThrow(() => assertSnapshotSane(baseMetrics({ prev })));
});

test("assertSnapshotSane: a genuinely bad total-supply read still trips against a legacy prev", () => {
  // Even after normalizing the legacy prev up by the dev-vesting offset, a read
  // that is ~100M off must still be rejected.
  const prev = {
    totalSupply: 811_000_000 - DEV_VESTING,
    devVestingSupply: null,
  };
  const metrics = baseMetrics({ totalSupply: 911_000_000, prev });
  assert.throws(() => assertSnapshotSane(metrics), SnapshotSanityError);
});

test("assertSnapshotSane: corrected prev (devVestingSupply set) compares directly", () => {
  // Both rows on the raw basis; a small daily mint passes.
  const prev = {
    totalSupply: 810_600_000,
    devVestingSupply: DEV_VESTING,
  };
  assert.doesNotThrow(() => assertSnapshotSane(baseMetrics({ prev })));
});

test("assertSnapshotSane: implausible move vs a corrected prev trips", () => {
  const prev = {
    totalSupply: 800_000_000, // 11M lower on the same basis — implausible daily
    devVestingSupply: DEV_VESTING,
  };
  assert.throws(
    () => assertSnapshotSane(baseMetrics({ prev })),
    SnapshotSanityError
  );
});

test("assertSnapshotSane: rejects non-positive core figures", () => {
  assert.throws(
    () => assertSnapshotSane(baseMetrics({ circulating: 0 })),
    SnapshotSanityError
  );
  assert.throws(
    () => assertSnapshotSane(baseMetrics({ mintedSupply: 0 })),
    SnapshotSanityError
  );
});
