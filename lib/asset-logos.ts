// Symbol -> logo URI map for decorating asset rows across the dashboard
// (treasury holdings, rate limits). SYMBOL-keyed deliberately: several surfaces
// (treasury AssetTotal) aggregate by display symbol and carry no denom, and
// logos are cosmetic — a missed lookup simply renders no logo, so the
// denom-precision rule for financial matching doesn't bind here.
//
// The map is built by DENOM JOIN across the symbol vocabularies in play, since
// they drift (the assetlist calls ibc/987C17… "STARS.og" while Numia — whose
// symbols the treasury displays — calls it "STARS.legacy"):
//   1. assetlist symbols -> that asset's logo (first entry wins, so canonical
//      assets beat later variants sharing a symbol);
//   2. Numia symbols -> the logo of the denom Numia attaches the symbol to;
//   3. treasury display overrides (DENOM_SYMBOL_OVERRIDES / price overrides)
//      -> the logo of the overridden denom.
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

export async function fetchSymbolLogoMap(): Promise<Record<string, string>> {
  try {
    const resp = await fetch(ASSETLIST_URL, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`assetlist HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      assets: Array<{
        symbol?: string;
        coinMinimalDenom?: string;
        logoURIs?: { svg?: string; png?: string };
      }>;
    };

    const bySymbol: Record<string, string> = {};
    const byDenom: Record<string, string> = {};
    for (const asset of data.assets ?? []) {
      const logo = asset.logoURIs?.svg ?? asset.logoURIs?.png;
      if (!logo) continue;
      if (asset.symbol && !(asset.symbol in bySymbol))
        bySymbol[asset.symbol] = logo;
      if (asset.coinMinimalDenom && !(asset.coinMinimalDenom in byDenom))
        byDenom[asset.coinMinimalDenom] = logo;
    }

    // Numia's symbols are what the treasury rows display; join them to the
    // assetlist logos through the shared denom. Best-effort: a Numia outage
    // just leaves the assetlist-only map.
    try {
      const headers: HeadersInit = { Accept: "application/json" };
      if (NUMIA_API_KEY) headers.Authorization = `Bearer ${NUMIA_API_KEY}`;
      const numiaResp = await fetch(`${NUMIA_API_URL}/tokens/v2/all`, {
        headers,
      });
      if (numiaResp.ok) {
        const tokens = (await numiaResp.json()) as Array<{
          denom?: string;
          symbol?: string;
        }>;
        for (const t of tokens) {
          if (!t.symbol || t.symbol in bySymbol || !t.denom) continue;
          const logo = byDenom[t.denom];
          if (logo) bySymbol[t.symbol] = logo;
        }
      }
    } catch (error) {
      logger.warn("Numia symbol join skipped for logo map:", error);
    }

    // Treasury display-symbol overrides: those symbols replace the source
    // symbol on the rendered rows, so they need the underlying denom's logo.
    for (const [denom, symbol] of Object.entries(DENOM_SYMBOL_OVERRIDES)) {
      if (!(symbol in bySymbol) && byDenom[denom]) {
        bySymbol[symbol] = byDenom[denom];
      }
    }
    for (const [denom, info] of Object.entries(PRICE_OVERRIDES_BY_DENOM)) {
      if (!(info.symbol in bySymbol) && byDenom[denom]) {
        bySymbol[info.symbol] = byDenom[denom];
      }
    }

    return bySymbol;
  } catch (error) {
    logger.warn(
      "Assetlist symbol-logo fetch failed; rows show text only:",
      error
    );
    return {};
  }
}
