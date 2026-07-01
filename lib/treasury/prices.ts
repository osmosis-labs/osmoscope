// Price / symbol / exponent resolution for the treasury engine.
//
// buildPriceMap() builds the base denom -> {symbol, price, exponent} map from
// Numia /tokens/v2/all plus four curated override layers (see
// config/community-pool.ts). It does NOT resolve the long tail of denoms Numia
// leaves unpriced — Numia lists ~2700 of them and pricing them all up-front was
// the dominant cost (~90s). Instead the snapshot builder calls
// resolveMissingPrices() with only the denoms the treasury actually holds, which
// runs the SQS (denom-keyed, Osmosis's own quote engine) then CoinGecko fallback
// on that small set. Ported/extended from the sheet's get_prices (which had no
// SQS layer and priced everything eagerly).
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

// Osmosis SQS (sidecar query server): the chain's own quote engine, used here as
// the denom-keyed price fallback between Numia and CoinGecko.
const SQS_API_URL = process.env.SQS_API_URL || "https://sqsprod.osmosis.zone";

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

  for (const item of list) {
    const info = effectivePriceRow(item, symbolIndex);
    map[info.denom] = {
      symbol: info.symbol,
      price: info.price,
      exponent: info.exponent,
    };
    // Remember a usable CoinGecko id per denom for the on-demand fallback.
    const cgId = coingeckoId(info.symbol);
    if (cgId) coingeckoIdByDenom[info.denom] = cgId;
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

  // NOTE: no SQS/CoinGecko fallback here. Numia lists ~2700 dead denoms with
  // null prices; resolving them all up-front (55 SQS batches + CoinGecko backoff)
  // took ~90s and priced denoms no holder touches. Instead the snapshot builder
  // calls resolveMissingPrices() with ONLY the denoms the treasury actually
  // holds — a few dozen — after decomposition. See resolveMissingPrices below.
  return map;
}

// CoinGecko-id index built alongside the price map, so the on-demand fallback can
// look up an id for a held denom without re-reading the Numia list.
const coingeckoIdByDenom: Record<string, string> = {};

// Fill in prices for a SMALL set of specific denoms the treasury holds but that
// Numia left unpriced. SQS (denom-keyed, Osmosis's own quote engine) first, then
// CoinGecko (needs a known id). Mutates `map` in place. Called with the held
// denoms only, so it does a couple of SQS batches instead of ~55.
export async function resolveMissingPrices(
  map: PriceMap,
  denoms: string[]
): Promise<void> {
  const missing = [...new Set(denoms)].filter(
    (d) => map[d] && !(map[d].price > 0)
  );
  if (missing.length === 0) return;

  // SQS pass.
  const sqsPrices = await fetchSqsPrices(missing);
  for (const denom of missing) {
    const p = sqsPrices[denom];
    if (p != null && p > 0) map[denom].price = p;
  }

  // CoinGecko pass for whatever SQS still couldn't price.
  const cgWanted = missing.filter(
    (d) => !(map[d].price > 0) && coingeckoIdByDenom[d]
  );
  if (cgWanted.length > 0) {
    const cgPrices = await fetchCoinGeckoPrices([
      ...new Set(cgWanted.map((d) => coingeckoIdByDenom[d])),
    ]);
    for (const denom of cgWanted) {
      const p = cgPrices[coingeckoIdByDenom[denom]];
      if (p != null && !(map[denom].price > 0))
        map[denom].price = Number(p) || 0;
    }
  }
}

// SQS batch prices. GET /tokens/prices?base=<denom,denom,...> returns
//   { "<baseDenom>": { "<usdcQuoteDenom>": "<priceString>" }, ... }
// where the price is USD (USDC-quoted) per WHOLE display token — the same unit
// as our PriceMap.price, so no exponent math is needed. Denom-keyed, so it prices
// bridged variants a symbol source misses.
//
// SQS 400s the WHOLE batch if ANY denom in it is one it doesn't recognize, so a
// single bad denom would otherwise wipe out prices for all the good ones in the
// batch. On a 400 we split the batch and retry the halves (down to singletons),
// so only the genuinely-bad denom is dropped. Whatever SQS can't price falls
// through to the CoinGecko pass in resolveMissingPrices.
async function fetchSqsPrices(
  denoms: string[]
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const CHUNK = 50;
  for (let i = 0; i < denoms.length; i += CHUNK) {
    await fetchSqsChunk(denoms.slice(i, i + CHUNK), out);
  }
  return out;
}

// Fetch one batch; on a 400 (an unrecognized denom poisoned the batch), recurse
// on halves so the good denoms still resolve. A singleton 400 = that denom is
// genuinely unknown to SQS; drop it.
async function fetchSqsChunk(
  chunk: string[],
  out: Record<string, number>
): Promise<void> {
  if (chunk.length === 0) return;
  const url = `${SQS_API_URL}/tokens/prices?base=${encodeURIComponent(
    chunk.join(",")
  )}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.status === 400 && chunk.length > 1) {
      // Split and retry the halves concurrently so isolating a bad denom doesn't
      // serialize into a long chain of round-trips.
      const mid = Math.floor(chunk.length / 2);
      await Promise.all([
        fetchSqsChunk(chunk.slice(0, mid), out),
        fetchSqsChunk(chunk.slice(mid), out),
      ]);
      return;
    }
    if (!resp.ok) {
      // 400 singleton (unknown denom) or other error: leave for CoinGecko.
      if (chunk.length > 1 || resp.status !== 400) {
        logger.warn(
          `SQS /tokens/prices HTTP ${resp.status} (${chunk.length} denoms)`
        );
      }
      return;
    }
    const data = (await resp.json()) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const denom of chunk) {
      const quotes = data[denom];
      if (!quotes) continue;
      // One quote denom (USDC); take its value. Guard against 0 / NaN.
      const raw = Object.values(quotes)[0];
      const price = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(price) && price > 0) out[denom] = price;
    }
  } catch (e) {
    logger.warn(`SQS price fetch error: ${(e as Error).message}`);
  }
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

// A CoinGecko id for the fallback, but ONLY from the curated
// COINGECKO_ID_BY_SYMBOL table — deliberately NOT Numia's per-token
// `coingecko_id`. Numia tags ~130 dead/illiquid denoms with a (often stale)
// coingecko_id; trusting those made the fallback fan out to ~16 CoinGecko chunks,
// each with a multi-second rate-limit sleep, to price denoms that never resolve.
// SQS already covers everything the treasury materially holds, so CoinGecko is a
// last resort reserved for the handful of assets we've explicitly listed.
function coingeckoId(effectiveSymbol: string): string | null {
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
