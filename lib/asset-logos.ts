// Symbol -> logo URI map for decorating asset rows on the Treasury page.
// SYMBOL-keyed deliberately: the treasury aggregates by display symbol
// (AssetTotal carries no denom), and logos are cosmetic — a missed lookup
// simply renders no logo, so the denom-precision rule for financial matching
// doesn't bind here.
//
// The map is built by DENOM JOIN across the symbol vocabularies in play, since
// they drift (the assetlist calls ibc/987C17… "STARS.og" while Numia — whose
// symbols the treasury displays — calls it "STARS.legacy"):
//   1. assetlist symbols -> that asset's logo (first entry wins, so canonical
//      assets beat later variants sharing a symbol);
//   2. Numia symbols -> the logo of the denom Numia attaches the symbol to;
//   3. treasury display overrides (DENOM_SYMBOL_OVERRIDES / price overrides)
//      -> the logo of the overridden denom, applied LAST AND UNCONDITIONALLY:
//      they are this repo's own curated display mapping, so they must beat any
//      coincidental assetlist symbol.
//
// Known collision caveat (symbol keying's residual risk, measured 2026-07):
// ~17 tickers exist in both vocabularies attached to different denoms; for
// most the image is the same asset from a different file, and assetlist-first
// favours the alloy/major variant the treasury actually holds. APT and BTC are
// the two factually-wrong pairs — both long-tail tickers the treasury doesn't
// hold. The durable fix is threading denoms onto AssetTotal.
import { logger } from "./logger";
import {
  DENOM_SYMBOL_OVERRIDES,
  PRICE_OVERRIDES_BY_DENOM,
} from "@/config/community-pool";

const ASSETLIST_URL =
  "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/generated/frontend/assetlist.json";
const NUMIA_API_URL =
  process.env.NUMIA_API_URL || "https://public-osmosis-api.numia.xyz";
const NUMIA_API_KEY = process.env.NUMIA_API_KEY;

// Boundary validation: every URI the map can ever serve is rendered as an
// <img src> by every visitor, so only the repo-controlled hosting path is
// accepted — one mistaken/compromised assetlist entry must not become a
// third-party image request.
const ALLOWED_LOGO_PREFIX = "https://raw.githubusercontent.com/";

export interface AssetlistLogoAsset {
  symbol?: string;
  coinMinimalDenom?: string;
  logoURIs?: { svg?: string; png?: string };
}
export interface NumiaLogoToken {
  denom?: string;
  symbol?: string;
}

// Pure join, separated from the fetching so the precedence semantics are
// unit-testable (lib/asset-logos.test.ts).
export function buildSymbolLogoMapFrom(
  assets: AssetlistLogoAsset[],
  numiaTokens: NumiaLogoToken[],
  overrides: {
    denomSymbol: Record<string, string>;
    priceByDenom: Record<string, { symbol: string }>;
  } = {
    denomSymbol: DENOM_SYMBOL_OVERRIDES,
    priceByDenom: PRICE_OVERRIDES_BY_DENOM,
  }
): Record<string, string> {
  const bySymbol: Record<string, string> = {};
  const byDenom: Record<string, string> = {};
  for (const asset of assets) {
    const logo = asset.logoURIs?.svg ?? asset.logoURIs?.png;
    if (!logo || !logo.startsWith(ALLOWED_LOGO_PREFIX)) continue;
    if (asset.symbol && !(asset.symbol in bySymbol))
      bySymbol[asset.symbol] = logo;
    if (asset.coinMinimalDenom && !(asset.coinMinimalDenom in byDenom))
      byDenom[asset.coinMinimalDenom] = logo;
  }

  // Numia's symbols are what the treasury rows display; join them to the
  // assetlist logos through the shared denom.
  for (const t of numiaTokens) {
    if (!t.symbol || t.symbol in bySymbol || !t.denom) continue;
    const logo = byDenom[t.denom];
    if (logo) bySymbol[t.symbol] = logo;
  }

  // Treasury display-symbol overrides replace the source symbol on rendered
  // rows, so they get the underlying denom's logo — unconditionally: the
  // override is curated in this repo and cannot be wrong for the symbol it
  // itself defines, so it must beat a coincidental assetlist ticker.
  for (const [denom, symbol] of Object.entries(overrides.denomSymbol)) {
    if (byDenom[denom]) bySymbol[symbol] = byDenom[denom];
  }
  for (const [denom, info] of Object.entries(overrides.priceByDenom)) {
    if (byDenom[denom]) bySymbol[info.symbol] = byDenom[denom];
  }

  return bySymbol;
}

function createAbortController(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => clearTimeout(timeout);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  return { controller, cleanup };
}

export async function fetchSymbolLogoMap(): Promise<Record<string, string>> {
  try {
    const assetlist = createAbortController(10_000);
    try {
      const resp = await fetch(ASSETLIST_URL, {
        headers: { Accept: "application/json" },
        signal: assetlist.controller.signal,
      });
      if (!resp.ok) throw new Error(`assetlist HTTP ${resp.status}`);
      const data = (await resp.json()) as { assets: AssetlistLogoAsset[] };

      // Best-effort: a Numia outage just leaves the assetlist-only map.
      let numiaTokens: NumiaLogoToken[] = [];
      try {
        const headers: HeadersInit = { Accept: "application/json" };
        if (NUMIA_API_KEY) headers.Authorization = `Bearer ${NUMIA_API_KEY}`;
        const numia = createAbortController(15_000);
        try {
          const numiaResp = await fetch(`${NUMIA_API_URL}/tokens/v2/all`, {
            headers,
            signal: numia.controller.signal,
          });
          if (numiaResp.ok) {
            numiaTokens = (await numiaResp.json()) as NumiaLogoToken[];
          } else {
            logger.warn(
              `Numia symbol join skipped for logo map: HTTP ${numiaResp.status}`
            );
          }
        } finally {
          numia.cleanup();
        }
      } catch (error) {
        logger.warn("Numia symbol join skipped for logo map:", error);
      }

      return buildSymbolLogoMapFrom(data.assets ?? [], numiaTokens);
    } finally {
      assetlist.cleanup();
    }
  } catch (error) {
    logger.warn(
      "Assetlist symbol-logo fetch failed; rows show text only:",
      error
    );
    return {};
  }
}
