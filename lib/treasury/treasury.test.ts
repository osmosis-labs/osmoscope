// Unit tests for the pure valuation-engine functions. Run with `npm test`
// (Node's built-in test runner via tsx — no test-framework dependency).
//
// Scope: the pure, high-value functions that decide real money and were the
// review's flagged regression risks — tick->price math, the outlier-resistant
// median denom selection, per-symbol aggregation's priceUnavailable rule, the
// base/quote pair ordering, position classification, and OSMO-exposure.
import { test } from "node:test";
import assert from "node:assert/strict";

import { tickToBasePrice } from "./cl";
import { bestDenomForSymbol, type Holding } from "./holdings";
import {
  aggregateBySymbol,
  orderedPairLabel,
  classifyPosition,
} from "./snapshot";
import { isOsmoExposure } from "@/config/community-pool";
import { verifySqsPrices, type PriceMap } from "./prices";
import { isMoveConfirmed } from "./move-gate";

// --- tickToBasePrice (Osmosis geometric tick math) -------------------------
test("tickToBasePrice: reference points", () => {
  // tick 0 -> price 1 (the pivot).
  assert.equal(tickToBasePrice(0), 1);
  // Within the base band (exponent -6), each tick adds 1e-6.
  assert.ok(Math.abs(tickToBasePrice(100000) - 1.1) < 1e-9);
  // Higher band: 620000 -> 1.62 (matches the hand-verified pool 1397 bound).
  assert.ok(Math.abs(tickToBasePrice(620000) - 1.62) < 1e-9);
});

test("tickToBasePrice: monotonic and handles the min tick", () => {
  assert.ok(tickToBasePrice(200000) > tickToBasePrice(100000));
  // Osmosis min tick -108,000,000 -> 1e-12 (12 geometric bands below 1).
  assert.ok(Math.abs(tickToBasePrice(-108000000) - 1e-12) < 1e-20);
});

// --- bestDenomForSymbol (outlier-resistant median selection) ---------------
function priceMap(entries: Array<[string, string, number]>): PriceMap {
  const m: PriceMap = {};
  for (const [denom, symbol, price] of entries)
    m[denom] = { symbol, price, exponent: 6 };
  return m;
}

test("bestDenomForSymbol: rejects the mispriced USDC outlier", () => {
  // The $0.66 depegged variant must NOT win over the ~$1 canonical ones.
  const m = priceMap([
    ["ibc/BAD", "USDC", 0.66],
    ["ibc/GOOD1", "USDC", 1.0],
    ["ibc/GOOD2", "USDC", 1.0002],
  ]);
  const denom = bestDenomForSymbol(m, "USDC");
  assert.ok(denom !== null);
  assert.ok(m[denom as string].price >= 1); // never the $0.66 one
});

test("bestDenomForSymbol: falls back to any match when none priced", () => {
  const m = priceMap([["ibc/X", "FOO", 0]]);
  assert.equal(bestDenomForSymbol(m, "FOO"), "ibc/X");
});

test("bestDenomForSymbol: null when the symbol is absent", () => {
  const m = priceMap([["ibc/X", "FOO", 1]]);
  assert.equal(bestDenomForSymbol(m, "NOPE"), null);
});

test("bestDenomForSymbol: case-insensitive match (EVM path)", () => {
  const m = priceMap([["ibc/W", "WETH", 1600]]);
  assert.equal(bestDenomForSymbol(m, "weth", true), "ibc/W");
});

// --- aggregateBySymbol (priceUnavailable only if NOTHING priced) -----------
function holding(
  symbol: string,
  amount: number,
  value: number,
  priceUnavailable: boolean
): Holding {
  return { symbol, info: "", amount, value, denom: symbol, priceUnavailable };
}

test("aggregateBySymbol: sums amount/value and sorts value-desc", () => {
  const out = aggregateBySymbol([
    holding("OSMO", 10, 5, false),
    holding("USDC", 100, 100, false),
    holding("OSMO", 20, 10, false),
  ]);
  assert.equal(out[0].symbol, "USDC"); // higher value first
  const osmo = out.find((a) => a.symbol === "OSMO");
  assert.equal(osmo?.amount, 30);
  assert.equal(osmo?.value, 15);
});

test("aggregateBySymbol: unpriced only when NO component had a price", () => {
  // A symbol with one priced + one unpriced variant is NOT flagged unpriced.
  const mixed = aggregateBySymbol([
    holding("USDC", 1, 1, false),
    holding("USDC", 5, 0, true),
  ]);
  assert.equal(mixed[0].priceUnavailable, false);

  // A symbol with only unpriced components IS flagged.
  const dead = aggregateBySymbol([holding("DEAD", 5, 0, true)]);
  assert.equal(dead[0].priceUnavailable, true);
});

test("aggregateBySymbol: isOsmo flag set from the symbol", () => {
  const out = aggregateBySymbol([
    holding("stOSMO", 1, 1, false),
    holding("USDC", 1, 1, false),
  ]);
  assert.equal(out.find((a) => a.symbol === "stOSMO")?.isOsmo, true);
  assert.equal(out.find((a) => a.symbol === "USDC")?.isOsmo, false);
});

// --- orderedPairLabel (base / quote ordering) ------------------------------
test("orderedPairLabel: quote currency goes second", () => {
  assert.equal(orderedPairLabel("OSMO", "stOSMO"), "stOSMO / OSMO"); // OSMO is quote vs its LST
  assert.equal(orderedPairLabel("qOSMO", "OSMO"), "qOSMO / OSMO");
  assert.equal(orderedPairLabel("USDC", "XRP"), "XRP / USDC"); // stablecoin is quote
  assert.equal(orderedPairLabel("USDC", "OSMO"), "OSMO / USDC"); // stablecoin outranks OSMO
});

// --- classifyPosition (info -> kind + poolRef) -----------------------------
test("classifyPosition: kinds and pool refs", () => {
  assert.deepEqual(classifyPosition("USDC/BTC Magma"), {
    kind: "Magma",
    key: "USDC/BTC Magma",
    poolRef: undefined,
  });
  assert.deepEqual(classifyPosition("Classic Pool 10"), {
    kind: "Classic",
    key: "Classic Pool 10",
    poolRef: "10",
  });
  assert.deepEqual(classifyPosition("Locust Vault 1922"), {
    kind: "Margined",
    key: "Locust Vault 1922",
    poolRef: "1922",
  });
});

test("classifyPosition: excludes CL, rewards, bank, and Ethereum lines", () => {
  assert.equal(classifyPosition("CL Pool - 1252"), null);
  assert.equal(classifyPosition("CL Pool - 1252 rewards"), null);
  assert.equal(classifyPosition(""), null);
  assert.equal(classifyPosition("Ethereum"), null);
});

// --- isOsmoExposure (substring match + exclusions) -------------------------
test("isOsmoExposure: OSMO and derivatives are exposure", () => {
  for (const s of [
    "OSMO",
    "stOSMO",
    "bOSMO",
    "ampOSMO",
    "qOSMO",
    "OSMO-YIELD-LP",
  ])
    assert.equal(isOsmoExposure(s), true, s);
});

test("isOsmoExposure: WOSMO and non-OSMO assets are NOT exposure", () => {
  for (const s of ["WOSMO", "USDC", "ATOM", "BTC"])
    assert.equal(isOsmoExposure(s), false, s);
});

test("isOsmoExposure: ION counts as protocol-native exposure", () => {
  assert.equal(isOsmoExposure("ION"), true);
  assert.equal(isOsmoExposure("ion"), true);
});

// --- verifySqsPrices (SQS /tokens/prices outlier guard) ---------------------
// SQS's /tokens/prices has been seen quoting dTIA at $2.6e9 per token while
// /router/quote returned the correct ~$0.37, which booked ~$1.8M of phantom
// value onto 703 raw units of fee dust in the txfees staging accounts.
const DTIA =
  "ibc/C7A810C6ED1FC3FFC7C834A534D400EADC94FF7D3BE13DDD4C042AEF1816DFB4";

test("verifySqsPrices: leaves ordinary prices untouched and unqueried", async () => {
  let calls = 0;
  const out = await verifySqsPrices(
    { "ibc/TIA": 0.35, "ibc/ETH": 2500, "ibc/BTC": 79000 },
    async () => {
      calls++;
      return 1;
    }
  );
  // All below the threshold, so no cross-check requests at all.
  assert.equal(calls, 0);
  assert.deepEqual(out, { "ibc/TIA": 0.35, "ibc/ETH": 2500, "ibc/BTC": 79000 });
});

test("verifySqsPrices: replaces the dTIA-style outlier with the router price", async () => {
  const out = await verifySqsPrices({ [DTIA]: 2.6e9 }, async () => 0.3658);
  assert.equal(out[DTIA], 0.3658);
  // The 703 raw units (exponent 6) must now land under the $1 dust filter.
  assert.ok((703 / 1e6) * out[DTIA] < 1);
});

test("verifySqsPrices: keeps a high price the router corroborates", async () => {
  // A genuinely expensive asset above the threshold, confirmed within tolerance.
  const out = await verifySqsPrices(
    { "ibc/BIGBTC": 200_000 },
    async () => 199_000
  );
  assert.equal(out["ibc/BIGBTC"], 200_000);
});

test("verifySqsPrices: drops an unconfirmable high price rather than booking it", async () => {
  const out = await verifySqsPrices({ [DTIA]: 2.6e9 }, async () => null);
  // Dropped => denom stays unpriced (falls through to CoinGecko /
  // priceUnavailable) instead of contributing phantom value.
  assert.ok(!(DTIA in out));
});

test("verifySqsPrices: does not substitute zero for a dropped price", async () => {
  const out = await verifySqsPrices({ [DTIA]: 2.6e9 }, async () => null);
  assert.notEqual(out[DTIA], 0);
  assert.equal(out[DTIA], undefined);
});

// --- isMoveConfirmed (confirm-on-repeat for the 15% main-pool gate) ----------
// A genuine large move repeats run after run; a partial fetch doesn't.
test("isMoveConfirmed: needs three readings", () => {
  assert.equal(isMoveConfirmed([5_000_000]), false);
  assert.equal(isMoveConfirmed([5_000_000, 5_000_100]), false);
});

test("isMoveConfirmed: accepts three consecutive readings within 1%", () => {
  // e.g. a ~$1M community-pool spend off a ~$6.9M pool, with market drift.
  assert.equal(isMoveConfirmed([5_870_000, 5_850_000, 5_860_000]), true);
});

test("isMoveConfirmed: rejects readings that disagree (partial fetches)", () => {
  // Each run dropped a different position, so the values don't line up.
  assert.equal(isMoveConfirmed([5_000_000, 5_900_000, 5_400_000]), false);
});

test("isMoveConfirmed: only the newest three count", () => {
  // An early outlier doesn't block confirmation once three later runs agree...
  assert.equal(
    isMoveConfirmed([3_000_000, 5_860_000, 5_850_000, 5_855_000]),
    true
  );
  // ...and older agreement doesn't carry a newer outlier through.
  assert.equal(
    isMoveConfirmed([5_860_000, 5_850_000, 5_855_000, 3_000_000]),
    false
  );
});

test("isMoveConfirmed: never confirms zero or non-finite readings", () => {
  assert.equal(isMoveConfirmed([0, 0, 0]), false);
  assert.equal(isMoveConfirmed([NaN, NaN, NaN]), false);
});
