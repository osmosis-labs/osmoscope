// Price / symbol / exponent resolution for the treasury engine.
//
// Source: Numia /tokens/v2/all, then apply four curated override layers (see
// config/community-pool.ts), then fall back to CoinGecko for any denom still
// without a usable price. Produces a denom -> {symbol, price, exponent} map that
// the holdings engine uses to value balances. Ported from the sheet's get_prices.
import { logger } from "../logger";
import {
  PRICE_OVERRIDES_BY_DENOM,
  SYMBOL_PRICE_ALIASES,
  DENOM_SYMBOL_OVERRIDES,
  EXPONENT_OVERRIDES,
  COINGECKO_ID_BY_SYMBOL,
} from "@/config/community-pool";

const NUMIA_API_URL =
  process.env.NUMIA_API_URL || "https://public-osmosis-api.numia.xyz";
const NUMIA_API_KEY = process.env.NUMIA_API_KEY;

export interface PriceInfo {
  symbol: string;
  price: number;
  exponent: number;
}
export type PriceMap = Record<string, PriceInfo>;

interface NumiaToken {
  denom?: string;
  symbol?: string;
  price?: number;
  exponent?: number;
  coingecko_id?: string;
}

// Build the full denom -> PriceInfo map.
export async function buildPriceMap(): Promise<PriceMap> {
  const headers: HeadersInit = { Accept: "application/json" };
  if (NUMIA_API_KEY) headers.Authorization = `Bearer ${NUMIA_API_KEY}`;

  const resp = await fetch(`${NUMIA_API_URL}/tokens/v2/all`, { headers });
  if (!resp.ok) {
    throw new Error(`Numia /tokens/v2/all HTTP ${resp.status}`);
  }
  const list = (await resp.json()) as NumiaToken[];

  // symbol -> {price, exponent} index, used to resolve derivative aliases.
  const symbolIndex: Record<string, { price: number; exponent: number }> = {};
  for (const item of list) {
    if (!item?.symbol || item.price == null) continue;
    symbolIndex[String(item.symbol)] = {
      price: Number(item.price),
      exponent: Number.isFinite(item.exponent) ? (item.exponent as number) : 0,
    };
  }
  for (const ov of Object.values(PRICE_OVERRIDES_BY_DENOM)) {
    symbolIndex[ov.symbol] = { price: ov.price, exponent: ov.exponent };
  }

  const map: PriceMap = {};
  const needCoinGecko: Array<{ denom: string; cgId: string }> = [];

  for (const item of list) {
    const info = effectivePriceRow(item, symbolIndex);
    map[info.denom] = {
      symbol: info.symbol,
      price: info.price,
      exponent: info.exponent,
    };
    if (!(info.price > 0)) {
      const cgId = coingeckoId(item, info.symbol);
      if (cgId) needCoinGecko.push({ denom: info.denom, cgId });
    }
  }

  // Absolute per-denom overrides not present in the Numia list.
  for (const [denom, ov] of Object.entries(PRICE_OVERRIDES_BY_DENOM)) {
    if (!map[denom]) {
      map[denom] = {
        symbol: ov.symbol,
        price: ov.price,
        exponent: EXPONENT_OVERRIDES[ov.symbol] ?? ov.exponent,
      };
    }
  }

  // CoinGecko fallback for denoms still without a price.
  if (needCoinGecko.length > 0) {
    const cgPrices = await fetchCoinGeckoPrices([
      ...new Set(needCoinGecko.map((n) => n.cgId)),
    ]);
    for (const { denom, cgId } of needCoinGecko) {
      const p = cgPrices[cgId];
      if (p != null && map[denom] && !(map[denom].price > 0)) {
        map[denom].price = Number(p) || 0;
      }
    }
  }

  return map;
}

function effectivePriceRow(
  item: NumiaToken,
  symbolIndex: Record<string, { price: number; exponent: number }>
): { symbol: string; price: number; denom: string; exponent: number } {
  const originalSymbol = item?.symbol ? String(item.symbol) : "Unknown";
  const denom = item?.denom ? String(item.denom) : "";
  const apiPrice = item?.price != null ? Number(item.price) : null;
  const apiExp = Number.isFinite(item?.exponent)
    ? (item.exponent as number)
    : 0;

  // 1) Per-denom absolute override wins outright.
  const abs = PRICE_OVERRIDES_BY_DENOM[denom];
  if (abs) {
    const sym = abs.symbol || originalSymbol;
    return {
      symbol: sym,
      price: abs.price,
      denom,
      exponent: EXPONENT_OVERRIDES[sym] ?? abs.exponent ?? apiExp,
    };
  }

  // 2) Force display symbol for this denom.
  const symbol = DENOM_SYMBOL_OVERRIDES[denom] || originalSymbol;

  // 3) Derivative -> base symbol for price sourcing.
  const aliasBase = SYMBOL_PRICE_ALIASES[symbol];
  if (aliasBase) {
    const base = symbolIndex[aliasBase] || { price: 0, exponent: apiExp };
    return {
      symbol,
      price: Number(base.price || 0),
      denom,
      exponent: EXPONENT_OVERRIDES[symbol] ?? base.exponent ?? apiExp,
    };
  }

  return {
    symbol,
    price: Number(apiPrice || 0),
    denom,
    exponent: EXPONENT_OVERRIDES[symbol] ?? apiExp,
  };
}

function coingeckoId(item: NumiaToken, effectiveSymbol: string): string | null {
  if (item?.coingecko_id) return String(item.coingecko_id);
  const aliasBase = SYMBOL_PRICE_ALIASES[effectiveSymbol];
  if (aliasBase && COINGECKO_ID_BY_SYMBOL[aliasBase])
    return COINGECKO_ID_BY_SYMBOL[aliasBase];
  if (COINGECKO_ID_BY_SYMBOL[effectiveSymbol])
    return COINGECKO_ID_BY_SYMBOL[effectiveSymbol];
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Batch-fetch USD prices from CoinGecko for the given ids (chunked, with 429
// backoff). Missing ids simply don't appear in the result.
async function fetchCoinGeckoPrices(
  ids: string[]
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  if (ids.length === 0) return results;

  const chunkSize = 8;
  const maxRetries = 4;
  const baseSleepMs = 5000;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url =
      "https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=" +
      encodeURIComponent(chunk.join(","));

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch(url);
        if (resp.status === 200) {
          const data = (await resp.json()) as Record<string, { usd?: number }>;
          for (const id of chunk) {
            const v = data[id]?.usd;
            if (v != null) results[id] = Number(v);
          }
          break;
        }
        if (resp.status === 429) {
          await sleep(baseSleepMs * attempt);
          continue;
        }
        logger.warn(`CoinGecko HTTP ${resp.status} for ${chunk.join(",")}`);
        break;
      } catch (e) {
        logger.warn(
          `CoinGecko fetch error for ${chunk.join(",")}: ${(e as Error).message}`
        );
        await sleep(baseSleepMs * attempt);
      }
    }
    await sleep(3000);
  }

  return results;
}
