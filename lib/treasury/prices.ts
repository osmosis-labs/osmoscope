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
  // CoinGecko-id index for THIS build only (keyed off the map object in a
  // WeakMap below), so overlapping builds (hourly cron / manual populate / dev
  // live API) can't interleave writes into a shared module-level object and
  // leave a stale denom->id mapping for resolveMissingPrices.
  const cgIndex: Record<string, string> = {};

  for (const item of list) {
    const info = effectivePriceRow(item, symbolIndex);
    map[info.denom] = {
      symbol: info.symbol,
      price: info.price,
      exponent: info.exponent,
    };
    // Remember a usable CoinGecko id per denom for the on-demand fallback.
    const cgId = coingeckoId(info.denom, info.symbol);
    if (cgId) cgIndex[info.denom] = cgId;
  }

  // Absolute per-denom overrides not present in the Numia list. EXPONENT_OVERRIDES
  // is denom-keyed, so check the denom first (then the symbol) before falling
  // back to the override's own exponent.
  for (const [denom, ov] of Object.entries(PRICE_OVERRIDES_BY_DENOM)) {
    if (!map[denom]) {
      map[denom] = {
        symbol: ov.symbol,
        price: ov.price,
        exponent:
          EXPONENT_OVERRIDES[denom] ??
          EXPONENT_OVERRIDES[ov.symbol] ??
          ov.exponent,
      };
    }
  }

  // NOTE: no SQS/CoinGecko fallback here. Numia lists ~2700 dead denoms with
  // null prices; resolving them all up-front (55 SQS batches + CoinGecko backoff)
  // took ~90s and priced denoms no holder touches. Instead the snapshot builder
  // calls resolveMissingPrices() with ONLY the denoms the treasury actually
  // holds — a few dozen — after decomposition. See resolveMissingPrices below.
  cgIndexByMap.set(map, cgIndex);
  return map;
}

// Per-build CoinGecko-id index, keyed by the PriceMap object it belongs to, so
// resolveMissingPrices reads the index for THAT build (no shared mutable module
// state that overlapping builds could corrupt). WeakMap => GC'd with the map.
const cgIndexByMap = new WeakMap<PriceMap, Record<string, string>>();

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

  // SQS pass. SQS returns USD per WHOLE display token, so it maps straight onto
  // map[denom].price (same unit) with no exponent math — but that relies on our
  // map[denom].exponent (incl. any EXPONENT_OVERRIDES) matching SQS's display
  // convention for that denom. For the hand-set overrides (alloyed allOP=12,
  // DOT.pica=10, allSHIB=12) confirm they agree with SQS, else the price is
  // right but `amount` (scaled by exponent in makeHolding) is off.
  const sqsPrices = await fetchSqsPrices(missing);
  const verified = await verifySqsPrices(sqsPrices);
  for (const denom of missing) {
    const p = verified[denom];
    if (p != null && p > 0) map[denom].price = p;
  }

  // CoinGecko pass for whatever SQS still couldn't price. Use the id index built
  // for THIS map (empty if the map didn't come from buildPriceMap).
  const cgIndex = cgIndexByMap.get(map) ?? {};
  const cgWanted = missing.filter((d) => !(map[d].price > 0) && cgIndex[d]);
  if (cgWanted.length > 0) {
    const cgPrices = await fetchCoinGeckoPrices([
      ...new Set(cgWanted.map((d) => cgIndex[d])),
    ]);
    for (const denom of cgWanted) {
      const p = cgPrices[cgIndex[denom]];
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

// USDC (the quote denom SQS prices against), used by the router cross-check.
const USDC_DENOM =
  "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";

// Above this USD-per-whole-token price an SQS /tokens/prices reading is treated
// as unproven and must be confirmed by an actual swap quote. Deliberately well
// clear of the genuinely expensive things the treasury holds (BTC ~$79k and its
// allBTC/wBTC variants are the ceiling in practice), so the cross-check fires on
// a handful of denoms at most and costs a handful of requests.
export const PRICE_VERIFY_THRESHOLD = 150_000;

// How far a high /tokens/prices reading may sit from the router's own quote
// before we discard it. Generous (5x) because the two paths legitimately differ
// on thin books — spread, price impact on the 1-token probe, and stale TWAP vs
// spot. A real mispricing is orders of magnitude out, not a few multiples:
// observed dTIA was 7.1e9x the router price, while allBTC/allETH agree to ~1%.
const PRICE_VERIFY_MAX_RATIO = 5;

// Guard against SQS /tokens/prices returning a wildly wrong figure for a thin or
// broken denom. That endpoint has been seen quoting dTIA at $2.6e9 per token
// (~7.1e9x its true value) while /router/quote for the same denom returns the
// correct ~$0.37 — enough to add ~$1.8M of phantom value to the txfees staging
// accounts from ~703 raw units of fee dust.
//
// Only prices above PRICE_VERIFY_THRESHOLD are checked, so the normal path is
// untouched. A checked price is kept only if an actual 1-token swap quote agrees
// within PRICE_VERIFY_MAX_RATIO; otherwise we prefer the router's number, and if
// the router can't quote it either we drop the price entirely so the denom falls
// through to CoinGecko and then shows as priceUnavailable. Never silently
// substitutes zero — dropping means "unpriced", which the snapshot surfaces.
// `quote` is injectable so the rule can be unit-tested without network access;
// production callers use the default (fetchRouterPrice).
export async function verifySqsPrices(
  prices: Record<string, number>,
  quote: (denom: string) => Promise<number | null> = fetchRouterPrice
): Promise<Record<string, number>> {
  const out = { ...prices };
  const suspect = Object.keys(out).filter(
    (d) => out[d] > PRICE_VERIFY_THRESHOLD
  );
  if (suspect.length === 0) return out;

  await Promise.all(
    suspect.map(async (denom) => {
      const quoted = await quote(denom);
      if (quoted == null) {
        // No corroboration available for an already-implausible number: drop it
        // rather than book millions of phantom value.
        logger.warn(
          `SQS price ${out[denom]} for ${denom} exceeds ${PRICE_VERIFY_THRESHOLD} and no router quote could confirm it; dropping`
        );
        delete out[denom];
        return;
      }
      const ratio = out[denom] / quoted;
      if (
        ratio > PRICE_VERIFY_MAX_RATIO ||
        ratio < 1 / PRICE_VERIFY_MAX_RATIO
      ) {
        logger.warn(
          `SQS price ${out[denom]} for ${denom} disagrees with router quote ${quoted} (${ratio.toExponential(2)}x); using the router price`
        );
        out[denom] = quoted;
      }
    })
  );
  return out;
}

// USD price for ONE whole token of `denom`, from an actual router swap quote.
// Independent of /tokens/prices, so it can corroborate (or refute) it. Needs the
// denom's exponent to size the 1-token probe; read it from SQS's own metadata so
// the probe matches SQS's display convention rather than a guess. Returns null if
// the exponent or the quote is unavailable.
async function fetchRouterPrice(denom: string): Promise<number | null> {
  try {
    const exponent = await fetchSqsExponent(denom);
    if (exponent == null) return null;
    const oneToken = 10n ** BigInt(exponent);
    const url =
      `${SQS_API_URL}/router/quote?tokenIn=${oneToken}${encodeURIComponent(denom)}` +
      `&tokenOutDenom=${encodeURIComponent(USDC_DENOM)}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { amount_out?: string | number };
    if (data?.amount_out == null) return null;
    // USDC is 6-decimal; amount_out is in its minimal units.
    const usd = Number(data.amount_out) / 1e6;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch (e) {
    logger.warn(
      `Router price cross-check failed for ${denom}: ${(e as Error).message}`
    );
    return null;
  }
}

// The denom's display exponent per SQS's asset list, cached for the process.
async function fetchSqsExponent(denom: string): Promise<number | null> {
  if (sqsExponents == null) {
    sqsExponents = (async () => {
      const map: Record<string, number> = {};
      try {
        const resp = await fetch(`${SQS_API_URL}/tokens/metadata`, {
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) {
          logger.warn(`SQS /tokens/metadata HTTP ${resp.status}`);
          return map;
        }
        const data = (await resp.json()) as Record<
          string,
          { decimals?: number } | undefined
        >;
        for (const [d, meta] of Object.entries(data)) {
          if (meta && Number.isFinite(meta.decimals))
            map[d] = meta.decimals as number;
        }
      } catch (e) {
        logger.warn(`SQS /tokens/metadata error: ${(e as Error).message}`);
      }
      return map;
    })();
  }
  const exps = await sqsExponents;
  return exps[denom] ?? null;
}

// Process-lifetime cache of the SQS metadata fetch (a promise, so concurrent
// callers share one request). Only touched on the rare cross-check path.
let sqsExponents: Promise<Record<string, number>> | null = null;

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

  // EXPONENT_OVERRIDES is keyed by DENOM (factory/.../allOP, ibc/... etc.), so
  // look up by denom first, then symbol as a fallback. The previous symbol-only
  // lookups never matched the denom-keyed config, so the curated decimal fixes
  // were skipped and makeHolding scaled with Numia's default exponent.
  const expOverride = (sym: string): number | undefined =>
    EXPONENT_OVERRIDES[denom] ?? EXPONENT_OVERRIDES[sym];

  // 1) Per-denom absolute override wins outright.
  const abs = PRICE_OVERRIDES_BY_DENOM[denom];
  if (abs) {
    const sym = abs.symbol || originalSymbol;
    return {
      symbol: sym,
      price: abs.price,
      denom,
      exponent: expOverride(sym) ?? abs.exponent ?? apiExp,
    };
  }

  // 2) Force display symbol for this denom.
  const symbol = DENOM_SYMBOL_OVERRIDES[denom] || originalSymbol;

  // 3) Derivative -> base symbol for price sourcing. SYMBOL_PRICE_ALIASES is
  // keyed by DENOM (e.g. the YieldETH ibc/... denom -> "ETH"), so look up by
  // denom first; fall back to the symbol so a symbol-keyed alias would also work.
  const aliasBase = SYMBOL_PRICE_ALIASES[denom] ?? SYMBOL_PRICE_ALIASES[symbol];
  if (aliasBase) {
    const base = symbolIndex[aliasBase] || { price: 0, exponent: apiExp };
    return {
      symbol,
      price: Number(base.price || 0),
      denom,
      exponent: expOverride(symbol) ?? base.exponent ?? apiExp,
    };
  }

  return {
    symbol,
    price: Number(apiPrice || 0),
    denom,
    exponent: expOverride(symbol) ?? apiExp,
  };
}

// A CoinGecko id for the fallback, but ONLY from the curated
// COINGECKO_ID_BY_SYMBOL table — deliberately NOT Numia's per-token
// `coingecko_id`. Numia tags ~130 dead/illiquid denoms with a (often stale)
// coingecko_id; trusting those made the fallback fan out to ~16 CoinGecko chunks,
// each with a multi-second rate-limit sleep, to price denoms that never resolve.
// SQS already covers everything the treasury materially holds, so CoinGecko is a
// last resort reserved for the handful of assets we've explicitly listed.
function coingeckoId(denom: string, effectiveSymbol: string): string | null {
  // SYMBOL_PRICE_ALIASES is denom-keyed; look up by denom first, then symbol.
  const aliasBase =
    SYMBOL_PRICE_ALIASES[denom] ?? SYMBOL_PRICE_ALIASES[effectiveSymbol];
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
