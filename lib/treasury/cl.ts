// Concentrated-liquidity position support for the treasury engine.
//
// Fetches an address's CL positions as STRUCTURED objects (not flattened line
// items) so the /treasury page can render Osmosis-frontend-style position cards:
// a price range (from the position's ticks), per-token amounts + values, any
// uncollected rewards, and the total position value. Server-only.
import { logger } from "../logger";
import { fetchLcdJson } from "./fetch";
import type { PriceMap } from "./prices";
import type { Holding } from "./holdings";

// --- Osmosis tick -> price -------------------------------------------------
// Ports the chain's tick math (osmosis/x/concentrated-liquidity math/tick.go).
// CL prices are geometric: each power-of-ten "geometric exponent" spans
// 9,000,000 ticks, and within a band the additive increment is 10^exponent with
// a base exponent of -6. Returns the price of one BASE unit of token0 in base
// units of token1 (i.e. still in minimal denoms — caller adjusts by decimals).
const GEOMETRIC_EXPONENT_TICKS = 9_000_000;
const BASE_EXPONENT = -6;

export function tickToBasePrice(tick: number): number {
  const geoDelta = Math.floor(tick / GEOMETRIC_EXPONENT_TICKS);
  const exponentAtTick = BASE_EXPONENT + geoDelta;
  const additiveIncrement = Math.pow(10, exponentAtTick);
  const numAdditiveTicks = tick - geoDelta * GEOMETRIC_EXPONENT_TICKS;
  return Math.pow(10, geoDelta) + numAdditiveTicks * additiveIncrement;
}

// Convert a base-unit price (token1 per token0 in minimal denoms) to a DISPLAY
// price (token1 per token0 in display units), correcting for the two tokens'
// decimal exponents: displayPrice = basePrice * 10^(exp0 - exp1).
function toDisplayPrice(basePrice: number, exp0: number, exp1: number): number {
  return basePrice * Math.pow(10, exp0 - exp1);
}

export interface ClRewardAsset {
  symbol: string;
  denom: string;
  amount: number;
  value: number;
  priceUnavailable: boolean;
}

export interface ClPosition {
  positionId: string;
  poolId: string;
  // Display price range (token1 per token0). Nulls if either token is unpriced/
  // exponent-unknown so we don't show a misleading range.
  lowerPrice: number | null;
  upperPrice: number | null;
  // Token symbols for the range label ("<token1> per <token0>").
  token0Symbol: string;
  token1Symbol: string;
  // True when the position is out of range (currently earning no fees). Inferred
  // from the composition: an in-range position holds BOTH tokens; once price
  // leaves the range it converts entirely to one side, so exactly one of asset0/
  // asset1 goes to zero. (Avoids a per-pool current-tick query; the public LCDs
  // return 501 for the pool endpoints.)
  outOfRange: boolean;
  // Underlying assets (asset0, asset1).
  assets: ClRewardAsset[];
  // Uncollected spread rewards + incentives, summed by symbol.
  rewards: ClRewardAsset[];
  // Total value = underlying assets + rewards (rewards included per config).
  value: number;
}

interface RawAsset {
  denom: string;
  amount: string;
}
interface RawPosition {
  position: {
    position_id: string;
    pool_id: string;
    lower_tick: string;
    upper_tick: string;
  };
  asset0?: RawAsset;
  asset1?: RawAsset;
  claimable_spread_rewards?: RawAsset[];
  claimable_incentives?: RawAsset[];
}

function valueAsset(
  denom: string,
  rawAmount: string,
  priceMap: PriceMap
): ClRewardAsset {
  const p = priceMap[denom] ?? { symbol: "Unknown", price: 0, exponent: 0 };
  const amount = parseFloat(rawAmount || "0") / Math.pow(10, p.exponent || 0);
  const priceUnavailable = !(p.price > 0);
  return {
    symbol: p.symbol,
    denom,
    amount,
    value: priceUnavailable ? 0 : amount * p.price,
    priceUnavailable,
  };
}

// Sum a list of reward coins by symbol (spread rewards + incentives combined).
function sumRewards(coins: RawAsset[], priceMap: PriceMap): ClRewardAsset[] {
  const bySymbol = new Map<string, ClRewardAsset>();
  for (const c of coins) {
    const a = valueAsset(c.denom, c.amount, priceMap);
    if (a.amount === 0) continue;
    const cur = bySymbol.get(a.symbol) ?? {
      symbol: a.symbol,
      denom: a.denom,
      amount: 0,
      value: 0,
      priceUnavailable: false,
    };
    cur.amount += a.amount;
    cur.value += a.value;
    cur.priceUnavailable = cur.priceUnavailable || a.priceUnavailable;
    bySymbol.set(a.symbol, cur);
  }
  return [...bySymbol.values()];
}

// Flatten a CL position into plain Holdings (underlying assets + rewards) so the
// treasury's by-symbol aggregation and totals can consume CL value through the
// same path as everything else. `info` marks them as CL lines for the position
// grouping in the flat "liquidity positions" view, and keeps them OUT of the
// plain per-symbol bank rows. Rewards are included (per the value convention).
export function clPositionToHoldings(pos: ClPosition): Holding[] {
  const info = `CL Pool - ${pos.poolId}`;
  const rows = [
    ...pos.assets.map((a) => ({ ...a, info })),
    ...pos.rewards.map((a) => ({ ...a, info: `${info} rewards` })),
  ];
  return rows.map((a) => ({
    symbol: a.symbol,
    info: a.info,
    amount: a.amount,
    value: a.value,
    denom: a.denom,
    priceUnavailable: a.priceUnavailable,
  }));
}

// Fetch an address's CL positions as structured cards. No swallowing catch on the
// list call (a failure should abort the snapshot, not silently drop positions);
// only per-token pricing gaps are tolerated (flagged, not fatal).
export async function fetchClPositions(
  address: string,
  priceMap: PriceMap
): Promise<ClPosition[]> {
  const posList = await fetchLcdJson<{ positions: RawPosition[] }>(
    `/osmosis/concentratedliquidity/v1beta1/positions/${address}`
  );

  const out: ClPosition[] = [];
  for (const p of posList.positions || []) {
    const pos = p.position;
    const a0 = p.asset0;
    const a1 = p.asset1;
    const asset0 = a0 ? valueAsset(a0.denom, a0.amount, priceMap) : null;
    const asset1 = a1 ? valueAsset(a1.denom, a1.amount, priceMap) : null;

    const exp0 = a0 ? (priceMap[a0.denom]?.exponent ?? null) : null;
    const exp1 = a1 ? (priceMap[a1.denom]?.exponent ?? null) : null;

    // Display range only when both exponents are known (else a wrong range is
    // worse than none — this is financial data).
    let lowerPrice: number | null = null;
    let upperPrice: number | null = null;
    if (exp0 != null && exp1 != null) {
      lowerPrice = toDisplayPrice(
        tickToBasePrice(Number(pos.lower_tick)),
        exp0,
        exp1
      );
      upperPrice = toDisplayPrice(
        tickToBasePrice(Number(pos.upper_tick)),
        exp0,
        exp1
      );
    }

    const rewards = sumRewards(
      [
        ...(p.claimable_spread_rewards || []),
        ...(p.claimable_incentives || []),
      ],
      priceMap
    );

    const assets = [asset0, asset1].filter(
      (x): x is ClRewardAsset => x != null
    );
    const value =
      assets.reduce((s, x) => s + x.value, 0) +
      rewards.reduce((s, x) => s + x.value, 0);

    // Out of range when the position holds only one side (the other converted
    // fully as price left the band). Requires both raw amounts present.
    const amt0 = parseFloat(a0?.amount ?? "0");
    const amt1 = parseFloat(a1?.amount ?? "0");
    const outOfRange = (amt0 === 0) !== (amt1 === 0);

    out.push({
      positionId: pos.position_id,
      poolId: pos.pool_id,
      lowerPrice,
      upperPrice,
      token0Symbol: asset0?.symbol ?? "?",
      token1Symbol: asset1?.symbol ?? "?",
      outOfRange,
      assets,
      rewards,
      value,
    });
  }

  logger.info(`CL positions for ${address}: ${out.length}`);
  return out;
}

// Resolve a pool id to its two underlying token symbols via the poolmanager
// endpoint. Used to label a vault whose current decomposition is one-sided (e.g.
// an out-of-range Margined vault that holds only OSMO) with its true pair.
// Returns null on any failure — this only enriches a display label, so it must
// never abort the snapshot. CL pools expose token0/token1 directly; other pool
// types fall back to the first two denoms of total_pool_liquidity.
export async function fetchPoolPairSymbols(
  poolId: string,
  priceMap: PriceMap
): Promise<[string, string] | null> {
  const symOf = (denom: string) => priceMap[denom]?.symbol ?? denom;
  try {
    const res = await fetchLcdJson<{
      pool?: { token0?: string; token1?: string };
    }>(`/osmosis/poolmanager/v1beta1/pools/${poolId}`);
    const t0 = res.pool?.token0;
    const t1 = res.pool?.token1;
    if (t0 && t1) return [symOf(t0), symOf(t1)];
  } catch {
    // fall through to the liquidity endpoint
  }
  try {
    const liq = await fetchLcdJson<{
      liquidity?: Array<{ denom: string }>;
    }>(`/osmosis/poolmanager/v1beta1/pools/${poolId}/total_pool_liquidity`);
    const denoms = (liq.liquidity ?? []).map((d) => d.denom);
    if (denoms.length >= 2) return [symOf(denoms[0]), symOf(denoms[1])];
  } catch {
    // give up — caller keeps the one-sided label
  }
  return null;
}
