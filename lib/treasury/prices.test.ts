// Decimals decide how a raw base-unit amount is sized, so a missing exponent
// must leave a denom unpriced rather than value it at 10^6 to 10^18 too much.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPriceMap, effectivePriceRow } from "./prices";
import { decomposeBankDenom } from "./holdings";
import { aggregateBySymbol } from "./snapshot";
import {
  EXPONENT_OVERRIDES,
  PRICE_OVERRIDES_BY_DENOM,
} from "../../config/community-pool";

const YIELDETH =
  "ibc/FBB3FEF80ED2344D821D4F95C31DBFD33E4E31D5324CAD94EF756E67B749F668";

test("a token without an exponent keeps its price and is flagged", () => {
  const row = effectivePriceRow(
    { denom: "ibc/NODECIMALS", symbol: "NODEC", price: 3 },
    {}
  );
  assert.equal(row.exponentUnknown, true);
  assert.equal(row.price, 3);
});

test("a priced denom with unknown decimals: an Osmosis amount is not valued", async () => {
  const [h] = await decomposeBankDenom("ibc/NODECIMALS", 5_000_000, {
    "ibc/NODECIMALS": {
      symbol: "NODEC",
      price: 3,
      exponent: 0,
      exponentUnknown: true,
    },
  });
  assert.equal(h.decimalsUnknown, true);
  assert.equal(h.priceUnavailable, true);
  assert.equal(h.value, 0);
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

const ALLETH =
  "factory/osmo1k6c8jln7ejuqwtqmay3yvzrg3kueaczl96pk067ldg8u835w0yhsw27twm/alloyed/allETH";

test("YieldETH is priced through allETH, not a fixed pin, with 18 decimals", () => {
  assert.equal(PRICE_OVERRIDES_BY_DENOM[YIELDETH], undefined);
  assert.equal(EXPONENT_OVERRIDES[YIELDETH], 18);
  const row = effectivePriceRow(
    { denom: YIELDETH, symbol: "YieldETH", price: 4200 },
    {
      ETH: { price: 9999, exponent: 18 },
      [ALLETH]: { price: 2421, exponent: 18 },
    }
  );
  assert.equal(
    row.price,
    2421,
    "priced from the allETH denom, not the ETH symbol"
  );
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
    { [ALLETH]: { price: 2421, exponent: 6 } }
  );
  assert.equal(row.exponent, 18);
});

test("a held denom with unknown decimals is flagged, unpriced and never valued", async () => {
  const [h] = await decomposeBankDenom("ibc/NODECIMALS", 5_000_000, {
    "ibc/NODECIMALS": {
      symbol: "NODEC",
      price: 0,
      exponent: 0,
      exponentUnknown: true,
    },
  });
  assert.equal(h.decimalsUnknown, true);
  assert.equal(h.amount, 0, "no raw base units in amount");
  assert.equal(h.priceUnavailable, true);
  assert.equal(h.value, 0);
  assert.equal(h.info, "", "info untouched, so position grouping is unchanged");
});

test("an unknown-decimals variant does not inflate its symbol's total", async () => {
  const priceMap = {
    "ibc/USDC": { symbol: "USDC", price: 1, exponent: 6 },
    "ibc/USDCX": {
      symbol: "USDC",
      price: 0,
      exponent: 0,
      exponentUnknown: true,
    },
  };
  const holdings = [
    ...(await decomposeBankDenom("ibc/USDC", 1_000_000, priceMap)),
    ...(await decomposeBankDenom("ibc/USDCX", 5_000_000, priceMap)),
  ];
  const [usdc] = aggregateBySymbol(holdings);
  assert.equal(usdc.amount, 1, "1 USDC, not 5,000,001");
  assert.equal(usdc.value, 1);
  assert.equal(usdc.decimalsUnknown, true, "the unknown part is flagged");
});

test("an aliased denom Numia does not list is still seeded and priced", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { denom: ALLETH, symbol: "ETH", price: 2421, exponent: 18 },
      ]),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  try {
    const map = await buildPriceMap();
    assert.deepEqual(map[YIELDETH], {
      symbol: "YieldETH",
      price: 2421,
      exponent: 18,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CL assets keep the unknown-decimals flag into holdings", async () => {
  const { clPositionToHoldings } = await import("./cl");
  const rows = clPositionToHoldings({
    positionId: "1",
    poolId: "1",
    assets: [
      {
        symbol: "NODEC",
        denom: "ibc/NODECIMALS",
        amount: 0,
        value: 0,
        priceUnavailable: true,
        decimalsUnknown: true,
      },
    ],
    rewards: [],
  } as unknown as Parameters<typeof clPositionToHoldings>[0]);
  assert.equal(rows[0].decimalsUnknown, true);
  const [total] = aggregateBySymbol(rows);
  assert.equal(total.decimalsUnknown, true);
});

test("a symbol-priced EVM holding keeps its value when Osmosis decimals are unknown", async () => {
  const { revalueHolding } = await import("./holdings");
  const h = revalueHolding(
    {
      symbol: "USDC",
      info: "",
      amount: 100,
      value: 0,
      denom: "evm:1:0xusdc",
      priceUnavailable: true,
    },
    {
      "ibc/USDC": {
        symbol: "USDC",
        price: 1,
        exponent: 0,
        exponentUnknown: true,
      },
    }
  );
  assert.equal(h.priceUnavailable, false);
  assert.equal(
    h.value,
    100,
    "amount is in the chain's own units, so the price applies"
  );
});

test("revaluation keeps an unknown-decimals holding unpriced and listed", async () => {
  const { revalueHolding } = await import("./holdings");
  const priceMap = {
    "ibc/NODECIMALS": {
      symbol: "NODEC",
      price: 3,
      exponent: 0,
      exponentUnknown: true,
    },
  };
  const [h] = await decomposeBankDenom("ibc/NODECIMALS", 5_000_000, priceMap);
  const r = revalueHolding(h, priceMap);
  assert.equal(r.priceUnavailable, true);
  assert.equal(r.decimalsUnknown, true);
  assert.equal(r.value, 0);
});

test("a known CL reward keeps its value beside an unknown-decimals variant", async () => {
  const { clPositionToHoldings } = await import("./cl");
  const { revalueHolding } = await import("./holdings");
  const rows = clPositionToHoldings({
    positionId: "1",
    poolId: "1",
    assets: [],
    rewards: [
      {
        symbol: "USDC",
        denom: "ibc/USDC",
        amount: 100,
        value: 100,
        priceUnavailable: false,
      },
      {
        symbol: "USDC",
        denom: "ibc/USDCX",
        amount: 0,
        value: 0,
        priceUnavailable: true,
        decimalsUnknown: true,
      },
    ],
  } as unknown as Parameters<typeof clPositionToHoldings>[0]);
  const priceMap = {
    "ibc/USDC": { symbol: "USDC", price: 1, exponent: 6 },
    "ibc/USDCX": {
      symbol: "USDC",
      price: 1,
      exponent: 0,
      exponentUnknown: true,
    },
  };
  const valued = rows.map((r) => revalueHolding(r, priceMap));
  assert.equal(
    valued.reduce((s, r) => s + r.value, 0),
    100
  );
});

test("YieldETH keeps a CoinGecko fallback through its own symbol", async () => {
  const { COINGECKO_ID_BY_SYMBOL, DENOM_SYMBOL_OVERRIDES } =
    await import("../../config/community-pool");
  assert.equal(DENOM_SYMBOL_OVERRIDES[YIELDETH], "YieldETH");
  assert.equal(COINGECKO_ID_BY_SYMBOL.YieldETH, COINGECKO_ID_BY_SYMBOL.ETH);
});
