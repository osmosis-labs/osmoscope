// Decimals decide how a raw base-unit amount is sized, so a missing exponent
// must leave a denom unpriced rather than value it at 10^6 to 10^18 too much.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectivePriceRow } from "./prices";
import {
  EXPONENT_OVERRIDES,
  PRICE_OVERRIDES_BY_DENOM,
} from "../../config/community-pool";

const YIELDETH =
  "ibc/FBB3FEF80ED2344D821D4F95C31DBFD33E4E31D5324CAD94EF756E67B749F668";

test("a token without an exponent is unpriced and flagged", () => {
  const row = effectivePriceRow(
    { denom: "ibc/NODECIMALS", symbol: "NODEC", price: 3 },
    {}
  );
  assert.equal(row.exponentUnknown, true);
  assert.equal(row.price, 0);
});

test("a token with Numia's exponent keeps price and decimals", () => {
  const row = effectivePriceRow(
    { denom: "uosmo", symbol: "OSMO", price: 0.2, exponent: 6 },
    {}
  );
  assert.equal(row.exponentUnknown, undefined);
  assert.equal(row.exponent, 6);
  assert.equal(row.price, 0.2);
});

test("YieldETH is priced through ETH, not a fixed pin, with 18 decimals", () => {
  assert.equal(PRICE_OVERRIDES_BY_DENOM[YIELDETH], undefined);
  assert.equal(EXPONENT_OVERRIDES[YIELDETH], 18);
  const row = effectivePriceRow(
    { denom: YIELDETH, symbol: "YieldETH", price: 4200 },
    { ETH: { price: 2484, exponent: 18 } }
  );
  assert.equal(row.price, 2484);
  assert.equal(row.exponent, 18);
});

test("an alias keeps its own decimals over the base symbol's", () => {
  const row = effectivePriceRow(
    {
      denom: YIELDETH,
      symbol: "YieldETH",
      price: null as unknown as number,
      exponent: 18,
    },
    { ETH: { price: 2484, exponent: 6 } }
  );
  assert.equal(row.exponent, 18);
});
