// Treasury snapshot orchestrator: builds the full community-pool / DAO-treasury
// breakdown by pricing everything, unwinding the main pool's holdings, and
// summing each associated address. Heavy (LCD + CosmWasm + EVM + price calls) —
// run from the hourly cron, not per request. Server-only.
import { logger } from "../logger";
import { buildPriceMap } from "./prices";
import {
  addressHoldings,
  clPositionHoldings,
  decomposeBankDenom,
  magmaHoldings,
  evmHoldings,
  sortHoldings,
  type Holding,
} from "./holdings";
import { fetchLcdJson } from "./fetch";
import {
  ASSOCIATED_ADDRESSES,
  COMMUNITY_POOL_CL_ADDRESS,
  COMMUNITY_POOL_MAGMA_ADDRESS,
} from "@/config/community-pool";

// One asset line, aggregated by symbol, in a breakdown.
export interface AssetTotal {
  symbol: string;
  amount: number;
  value: number;
  priceUnavailable: boolean;
}

// A treasury holder (the main pool, or an associated address).
export interface TreasuryHolder {
  label: string;
  address: string;
  chain: "osmosis" | "ethereum";
  totalValue: number;
  assets: AssetTotal[]; // aggregated by symbol, value-desc
}

export interface TreasurySnapshotData {
  timestamp: string;
  totalValue: number; // sum across all holders
  mainPool: {
    totalValue: number;
    holdings: Holding[]; // the detailed, decomposed line items (sorted)
  };
  holders: TreasuryHolder[]; // main pool + associated addresses, value-desc
  // Diagnostics: assets we couldn't price (surfaced, never silently valued 0).
  unpricedSymbols: string[];
}

// Aggregate a flat holdings list into per-symbol AssetTotals (value-desc).
function aggregateBySymbol(holdings: Holding[]): AssetTotal[] {
  const bySymbol = new Map<string, AssetTotal>();
  for (const h of holdings) {
    const cur = bySymbol.get(h.symbol) ?? {
      symbol: h.symbol,
      amount: 0,
      value: 0,
      priceUnavailable: false,
    };
    cur.amount += h.amount;
    cur.value += h.value;
    cur.priceUnavailable = cur.priceUnavailable || h.priceUnavailable;
    bySymbol.set(h.symbol, cur);
  }
  return [...bySymbol.values()].sort((a, b) => b.value - a.value);
}

// Build the full treasury snapshot. Throws on a clearly-broken result (e.g. the
// main pool priced at ~0) so the cron doesn't persist garbage over a good row.
export async function buildTreasurySnapshot(): Promise<TreasurySnapshotData> {
  const priceMap = await buildPriceMap();

  // --- Main community pool: distribution-module holdings + CL + Magma --------
  const mainHoldings: Holding[] = [];

  const poolData = await fetchLcdJson<{
    pool: Array<{ denom: string; amount: string }>;
  }>("/cosmos/distribution/v1beta1/community_pool");
  for (const item of poolData.pool || []) {
    mainHoldings.push(
      ...(await decomposeBankDenom(
        item.denom,
        parseFloat(item.amount || "0"),
        priceMap
      ))
    );
  }
  mainHoldings.push(
    ...(await clPositionHoldings(COMMUNITY_POOL_CL_ADDRESS, priceMap))
  );
  mainHoldings.push(
    ...(await magmaHoldings(COMMUNITY_POOL_MAGMA_ADDRESS, priceMap))
  );

  // Keep only lines worth >= $1 (matches the sheet), then sort/categorize.
  const mainFiltered = mainHoldings.filter(
    (h) => Number.isFinite(h.value) && h.value >= 1
  );
  const mainSorted = sortHoldings(mainFiltered);
  const mainTotal = mainSorted.reduce((s, h) => s + h.value, 0);

  // --- Associated addresses --------------------------------------------------
  const holders: TreasuryHolder[] = [
    {
      label: "Community Pool",
      address: "distribution-module",
      chain: "osmosis",
      totalValue: mainTotal,
      assets: aggregateBySymbol(mainSorted),
    },
  ];

  for (const a of ASSOCIATED_ADDRESSES) {
    const holdings =
      a.chain === "ethereum"
        ? await evmHoldings(a.address, "1", priceMap)
        : await addressHoldings(a.address, priceMap);
    const assets = aggregateBySymbol(
      holdings.filter((h) => Number.isFinite(h.value))
    );
    const totalValue = assets.reduce((s, x) => s + x.value, 0);
    holders.push({
      label: a.label,
      address: a.address,
      chain: a.chain,
      totalValue,
      assets,
    });
  }

  holders.sort((x, y) => y.totalValue - x.totalValue);
  const totalValue = holders.reduce((s, h) => s + h.totalValue, 0);

  const unpricedSymbols = [
    ...new Set(
      [...mainSorted, ...holders.flatMap((h) => h.assets)]
        .filter((h) => h.priceUnavailable)
        .map((h) => h.symbol)
    ),
  ];

  // Sanity gate: the main pool is always worth well over $1M; a near-zero result
  // means a broken price feed or LCD outage — refuse to persist it.
  if (!(mainTotal > 100_000)) {
    throw new Error(
      `Treasury snapshot main pool value implausibly low ($${mainTotal.toFixed(0)}); refusing to persist`
    );
  }

  logger.info(
    `Treasury snapshot: total $${totalValue.toFixed(0)} across ${holders.length} holders, ${unpricedSymbols.length} unpriced`
  );

  return {
    timestamp: new Date().toISOString(),
    totalValue,
    mainPool: { totalValue: mainTotal, holdings: mainSorted },
    holders,
    unpricedSymbols,
  };
}
