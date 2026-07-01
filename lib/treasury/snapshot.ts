// Treasury snapshot orchestrator: builds the full community-pool / DAO-treasury
// breakdown by pricing everything, unwinding the main pool's holdings, and
// summing each associated address. Heavy (LCD + CosmWasm + EVM + price calls) —
// run from the hourly cron, not per request. Server-only.
import { logger } from "../logger";
import { buildPriceMap, resolveMissingPrices } from "./prices";
import {
  addressHoldings,
  clPositionHoldings,
  decomposeBankDenom,
  magmaHoldings,
  evmHoldings,
  sortHoldings,
  revalueHolding,
  type Holding,
} from "./holdings";
import { fetchLcdJson } from "./fetch";
import { fetchClPositions, fetchPoolPairSymbols, type ClPosition } from "./cl";
import {
  ASSOCIATED_ADDRESSES,
  COMMUNITY_POOL_CL_ADDRESS,
  COMMUNITY_POOL_MAGMA_ADDRESS,
  isOsmoExposure,
} from "@/config/community-pool";

// Max concurrent per-address / per-denom fetch chains. Each chain fans out to
// several LCD/CosmWasm/EVM calls, so keep this modest to stay polite to the
// public endpoints while still collapsing the ~15 holders' wall-clock time.
const CONCURRENCY = 5;

// One asset line, aggregated by symbol, in a breakdown.
export interface AssetTotal {
  symbol: string;
  amount: number;
  value: number;
  priceUnavailable: boolean;
  isOsmo: boolean; // OSMO token or an OSMO LST/derivative (see isOsmoExposure)
}

// One underlying address of a holder (surfaced for explorer links).
export interface HolderAddress {
  address: string;
  chain: "osmosis" | "ethereum";
}

// A treasury holder: the main pool, a single associated address, or a group of
// addresses merged under one label (e.g. Grants = its Osmosis + Ethereum wallets).
export interface TreasuryHolder {
  label: string;
  // Primary address (first underlying); kept for a stable React key / back-compat.
  address: string;
  chain: "osmosis" | "ethereum";
  addresses: HolderAddress[]; // all underlying addresses (>1 for grouped holders)
  totalValue: number;
  assets: AssetTotal[]; // aggregated by symbol, value-desc
  // Curated explainer (what it is / how funded / where funds go), shown as a `?`
  // hover on the card. Optional (not every holder has one yet).
  description?: string;
  // Symbols this holder holds a nonzero amount of but couldn't price. Rendered on
  // the holder's own card, not the top banner.
  unpricedSymbols: string[];
}

// A CL position card with the entity that holds it, for the frontend-style
// positions section.
export interface ClPositionCard extends ClPosition {
  holderLabel: string;
}

// A non-CL liquidity position (Magma vault, Margined vault, or GAMM classic pool)
// shown as a card alongside the CL positions. These decompose into underlying
// assets but have no price range / in-range concept, so the card is simpler.
export interface VaultPositionCard {
  kind: "Magma" | "Margined" | "Classic";
  // Token-pair label like the CL cards, e.g. "USDC / XRP" or "qOSMO / OSMO",
  // derived from the two largest underlying assets.
  label: string;
  // Pool / vault reference (the id or vault number from the source), so a
  // position with a missing counterparty is still findable, e.g. "1922".
  poolRef?: string;
  holderLabel: string;
  value: number;
  assets: Array<{
    symbol: string;
    amount: number;
    value: number;
    priceUnavailable: boolean;
  }>;
}

export interface TreasurySnapshotData {
  timestamp: string;
  totalValue: number; // sum across all holders
  nonOsmoValue: number; // totalValue excluding OSMO + OSMO LSTs
  mainPool: {
    totalValue: number;
    holdings: Holding[]; // the detailed, decomposed line items (sorted)
  };
  holders: TreasuryHolder[]; // main pool + associated (Grants merged), value-desc
  // Treasury-wide per-asset totals across all holders (value-desc), for the
  // "By asset" summary and the value-by-token pie chart.
  byAsset: AssetTotal[];
  // Structured concentrated-liquidity positions across all holders (value-desc),
  // for the Osmosis-frontend-style position cards.
  clPositions: ClPositionCard[];
  // Non-CL liquidity positions (Magma / Margined vaults, GAMM classic pools)
  // across all holders (value-desc), shown as cards alongside the CL positions.
  vaultPositions: VaultPositionCard[];
  // Diagnostics: all assets we couldn't price (union across holders).
  unpricedSymbols: string[];
}

// Run `fn` over `items` with at most `limit` in flight; preserves input order.
// Bounds concurrency so the snapshot's dozens of LCD/CosmWasm/EVM calls run in
// parallel (fitting the cron's maxDuration) without hammering any one endpoint.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Aggregate a flat holdings list into per-symbol AssetTotals (value-desc).
//
// priceUnavailable is set only when the symbol has NO priced component at all —
// not when it merely has a stray unpriced dust variant. Many symbols (USDC, ETH,
// BTC) hold both a priced canonical denom and one or more dead/illiquid variants
// with no market price; ORing the flag would wrongly mark the whole symbol
// unpriced. So we track whether any priced holding contributed, and only flag the
// line when none did.
export function aggregateBySymbol(holdings: Holding[]): AssetTotal[] {
  type Acc = AssetTotal & { hasPriced: boolean };
  const bySymbol = new Map<string, Acc>();
  for (const h of holdings) {
    const cur: Acc = bySymbol.get(h.symbol) ?? {
      symbol: h.symbol,
      amount: 0,
      value: 0,
      priceUnavailable: false,
      isOsmo: isOsmoExposure(h.symbol),
      hasPriced: false,
    };
    cur.amount += h.amount;
    cur.value += h.value;
    if (!h.priceUnavailable) cur.hasPriced = true;
    bySymbol.set(h.symbol, cur);
  }
  return [...bySymbol.values()]
    .map(({ hasPriced, ...rest }) => ({
      ...rest,
      // Unpriced only if nothing under this symbol had a price.
      priceUnavailable: !hasPriced,
    }))
    .sort((a, b) => b.value - a.value);
}

// Classify a holding's `info` context into a vault/pool kind + a grouping key +
// a pool/vault reference id, or null if it's a plain balance / CL line (CL is
// surfaced separately). The decomposition tags Magma as "<sym0>/<sym1> Magma",
// GAMM as "Classic Pool <id>", and Margined vaults as the title-cased vault name
// (contains "Vault", ending in a number); CL as "CL Pool - <id>" and CL rewards
// as "... rewards" (both excluded here). `key` groups a position's rows; `poolRef`
// is the trailing id/number.
export function classifyPosition(
  info: string
): { kind: VaultPositionCard["kind"]; key: string; poolRef?: string } | null {
  const s = info.trim();
  if (!s || s === "Ethereum") return null;
  if (s.startsWith("CL Pool")) return null; // CL handled as its own cards
  const num = s.match(/(\d+)\s*$/)?.[1];
  if (/ Magma$/.test(s)) return { kind: "Magma", key: s, poolRef: num };
  if (/^Classic Pool /.test(s))
    return { kind: "Classic", key: s, poolRef: num };
  if (/vault/i.test(s)) return { kind: "Margined", key: s, poolRef: num };
  return null;
}

// Quote-currency rank for ordering a pair label as "base / quote". Higher rank =
// more quote-like, so it goes SECOND. Stablecoins are the strongest quote; plain
// OSMO is the quote against its own LSTs (so stOSMO/qOSMO/bOSMO/ampOSMO sort
// first, OSMO second); everything else is a base. Matches the CL cards' feel and
// the requested orderings (stOSMO / OSMO, XRP / USDC, qOSMO / OSMO).
function quoteRank(symbol: string): number {
  const s = symbol.toUpperCase();
  if (/^(USDC|USDT|USDN|DAI|USD)/.test(s)) return 3; // stablecoins: strongest quote
  if (s === "OSMO") return 2; // plain OSMO: quote vs its LSTs
  return 1; // base asset
}

// Order two symbols as "base / quote" (quote currency second). Used for both the
// vault decomposition label and the pool-derived fallback label.
export function orderedPairLabel(sym0: string, sym1: string): string {
  const [a, b] =
    quoteRank(sym0) <= quoteRank(sym1) ? [sym0, sym1] : [sym1, sym0];
  return `${a} / ${b}`;
}

// Group a holder's decomposed holdings into vault/pool position cards by their
// `info` context. Each card sums the underlying assets, then labels itself with
// the token pair (base / quote ordering), like the CL cards.
function buildVaultPositions(
  holderLabel: string,
  holdings: Holding[]
): VaultPositionCard[] {
  interface Acc {
    kind: VaultPositionCard["kind"];
    poolRef?: string;
    value: number;
    assets: VaultPositionCard["assets"];
  }
  const byKey = new Map<string, Acc>();
  for (const h of holdings) {
    const cls = classifyPosition(h.info);
    if (!cls) continue;
    const acc =
      byKey.get(cls.key) ??
      ({ kind: cls.kind, poolRef: cls.poolRef, value: 0, assets: [] } as Acc);
    acc.value += h.value;
    acc.assets.push({
      symbol: h.symbol,
      amount: h.amount,
      value: h.value,
      priceUnavailable: h.priceUnavailable,
    });
    byKey.set(cls.key, acc);
  }

  return [...byKey.values()].map((acc) => {
    // Distinct symbols held, largest value first.
    const bySym = new Map<string, number>();
    for (const a of acc.assets)
      bySym.set(a.symbol, (bySym.get(a.symbol) ?? 0) + a.value);
    const symbols = [...bySym.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s);
    // Pair label as "base / quote" (quote currency second). A one-sided vault
    // (e.g. an out-of-range position now holding a single token) is labelled with
    // just that symbol here; the snapshot builder later fills in the true pair
    // from the pool's own token0/token1.
    const label =
      symbols.length >= 2
        ? orderedPairLabel(symbols[0], symbols[1])
        : (symbols[0] ?? "Position");
    return {
      kind: acc.kind,
      label,
      poolRef: acc.poolRef,
      holderLabel,
      value: acc.value,
      assets: acc.assets,
    };
  });
}

// Symbols in an aggregated asset list that the holder holds a nonzero amount of
// but couldn't price. Feeds each holder's own "minor assets" notice.
function unpricedFrom(assets: AssetTotal[]): string[] {
  return assets
    .filter((a) => a.priceUnavailable && a.amount > 0)
    .map((a) => a.symbol)
    .sort((a, b) => a.localeCompare(b));
}

// Max fraction the main pool may move versus the previous snapshot before we
// treat the new value as broken. The pool is ~$7M of mostly stablecoins/majors;
// a real hour-over-hour move is small, so a >15% swing almost always means a
// partial fetch (some position dropped) rather than a genuine market move.
const MAX_MAIN_POOL_MOVE = 0.15;

export interface BuildSnapshotOptions {
  // Main-pool value of the last good stored snapshot, if any. When provided, the
  // sanity gate rejects a new snapshot whose main pool moved more than
  // MAX_MAIN_POOL_MOVE against it, so a partial undercount can't overwrite a
  // good row. Omit on the very first run (only the absolute floor applies).
  previousMainPoolValue?: number | null;
}

// Build the full treasury snapshot. Throws on a clearly-broken result (main pool
// near zero, or a large swing vs the previous snapshot) so the cron doesn't
// persist a partial/garbage result over a good row.
export async function buildTreasurySnapshot(
  options: BuildSnapshotOptions = {}
): Promise<TreasurySnapshotData> {
  const priceMap = await buildPriceMap();

  // --- Main community pool: distribution-module holdings + CL + Magma --------
  // The distribution-module denoms each need their own (possibly CosmWasm/GAMM)
  // decomposition; run those, the CL positions, and the Magma vaults with bounded
  // concurrency rather than one-at-a-time so the whole build fits the cron budget.
  const poolData = await fetchLcdJson<{
    pool: Array<{ denom: string; amount: string }>;
  }>("/cosmos/distribution/v1beta1/community_pool");

  const [bankBatches, clHoldings, magmaMainHoldings] = await Promise.all([
    mapLimit(poolData.pool || [], CONCURRENCY, (item) =>
      decomposeBankDenom(item.denom, parseFloat(item.amount || "0"), priceMap)
    ),
    clPositionHoldings(COMMUNITY_POOL_CL_ADDRESS, priceMap),
    magmaHoldings(COMMUNITY_POOL_MAGMA_ADDRESS, priceMap),
  ]);

  const mainHoldings: Holding[] = [
    ...bankBatches.flat(),
    ...clHoldings,
    ...magmaMainHoldings,
  ];

  // --- Associated addresses (gather RAW holdings first) ----------------------
  // Collect each holder's raw holdings without aggregating yet, so we can resolve
  // held-but-unpriced denoms in one pass before valuing anything.
  const rawAssociated = await mapLimit(
    ASSOCIATED_ADDRESSES,
    CONCURRENCY,
    async (a) => ({
      meta: a,
      holdings:
        a.chain === "ethereum"
          ? await evmHoldings(a.address, "1", priceMap)
          : await addressHoldings(a.address, priceMap),
    })
  );

  // --- Resolve prices for ONLY the denoms actually held ----------------------
  // Numia leaves ~2700 denoms unpriced; resolving all of them via SQS/CoinGecko
  // up-front took ~90s. Instead, gather the denoms these holdings reference and
  // price just those (a few dozen), then re-value the affected holdings.
  const heldDenoms = [
    ...mainHoldings,
    ...rawAssociated.flatMap((r) => r.holdings),
  ].map((h) => h.denom);
  await resolveMissingPrices(priceMap, heldDenoms);

  // Re-value against the now-complete price map (EVM synthetic denoms untouched).
  const mainRevalued = mainHoldings.map((h) => revalueHolding(h, priceMap));

  // Keep only lines worth >= $1 (matches the sheet), then sort/categorize.
  const mainFiltered = mainRevalued.filter(
    (h) => Number.isFinite(h.value) && h.value >= 1
  );
  const mainSorted = sortHoldings(mainFiltered);
  const mainTotal = mainSorted.reduce((s, h) => s + h.value, 0);

  const mainAssets = aggregateBySymbol(mainSorted);
  const holders: TreasuryHolder[] = [
    {
      label: "Community Pool",
      address: "distribution-module",
      chain: "osmosis",
      // Mintscan has a dedicated community-pool treasury page at the sentinel
      // address "community-pool"; link there rather than the CL holder address.
      addresses: [{ address: "community-pool", chain: "osmosis" }],
      totalValue: mainTotal,
      assets: mainAssets,
      description:
        "The chain's built in treasury module. Funded by a share of inflation, taker fees and pool creation fees. Governance spends this via community-pool spend proposals. Includes its deployed liquidity positions.",
      unpricedSymbols: unpricedFrom(mainAssets),
    },
  ];

  // Re-value + filter each associated address's holdings, keyed by its display
  // group. Addresses sharing a `group` (e.g. the two Grants wallets) accumulate
  // their raw holdings AND their addresses under one key; ungrouped addresses get
  // a unique key so each stays its own holder.
  interface GroupAcc {
    label: string;
    holdings: Holding[];
    addresses: HolderAddress[];
    primary: { address: string; chain: "osmosis" | "ethereum" };
    description?: string;
  }
  const groups = new Map<string, GroupAcc>();

  for (const { meta, holdings } of rawAssociated) {
    const revalued = holdings
      .map((h) => revalueHolding(h, priceMap))
      .filter((h) => Number.isFinite(h.value));
    const key = meta.group ?? `single:${meta.address}`;
    const acc = groups.get(key);
    if (acc) {
      acc.holdings.push(...revalued);
      acc.addresses.push({ address: meta.address, chain: meta.chain });
      // First non-empty description in the group wins.
      if (!acc.description && meta.description)
        acc.description = meta.description;
    } else {
      groups.set(key, {
        label: meta.groupLabel ?? meta.label,
        holdings: revalued,
        addresses: [{ address: meta.address, chain: meta.chain }],
        primary: { address: meta.address, chain: meta.chain },
        description: meta.description,
      });
    }
  }

  for (const acc of groups.values()) {
    const assets = aggregateBySymbol(acc.holdings);
    holders.push({
      label: acc.label,
      address: acc.primary.address,
      chain: acc.primary.chain,
      addresses: acc.addresses,
      totalValue: assets.reduce((s, x) => s + x.value, 0),
      assets,
      description: acc.description,
      unpricedSymbols: unpricedFrom(assets),
    });
  }

  holders.sort((x, y) => y.totalValue - x.totalValue);
  const totalValue = holders.reduce((s, h) => s + h.totalValue, 0);

  // --- CL position cards -----------------------------------------------------
  // Structured positions (range + per-token + rewards) for the frontend-style
  // cards, tagged with the entity that holds them. Fetched here (prices already
  // resolved). The community pool's CL positions live at the dedicated CL holder
  // address; associated Osmosis addresses may hold positions too.
  const clSources: Array<{ label: string; address: string }> = [
    { label: "Community Pool", address: COMMUNITY_POOL_CL_ADDRESS },
    ...ASSOCIATED_ADDRESSES.filter((a) => a.chain === "osmosis").map((a) => ({
      label: a.groupLabel ?? a.label,
      address: a.address,
    })),
  ];
  const clBatches = await mapLimit(clSources, CONCURRENCY, async (src) => {
    const positions = await fetchClPositions(src.address, priceMap);
    return positions.map((p) => ({ ...p, holderLabel: src.label }));
  });
  const clPositions: ClPositionCard[] = clBatches
    .flat()
    .sort((a, b) => b.value - a.value);

  // --- Vault / classic-pool position cards -----------------------------------
  // Magma + Margined vaults and GAMM classic pools already decompose into the
  // holdings above (tagged via `info`); group those into cards. The community
  // pool's are in mainSorted; each associated group's raw holdings are in
  // `groups`. Keep only positions worth >= $1.
  const vaultPositions: VaultPositionCard[] = [
    // Use the UNFILTERED revalued holdings (not mainSorted, which drops <$1 lines)
    // so a small vault whose individual asset lines are sub-$1 still forms a card.
    ...buildVaultPositions("Community Pool", mainRevalued),
    ...[...groups.values()].flatMap((acc) =>
      buildVaultPositions(acc.label, acc.holdings)
    ),
  ]
    // Kind-specific dust handling. A held VAULT (Magma / Margined) always shows
    // as long as it holds a nonzero AMOUNT of an underlying asset — keyed on
    // amount, not priced value, so a real but tiny/one-sided vault (e.g. the
    // qOSMO/OSMO vault, ~$2, whose qOSMO leg can momentarily be unpriced) doesn't
    // flicker in and out between hourly snapshots. CLASSIC (GAMM) pool shares are
    // dropped below $1: the community pool holds ~0 shares in ancient pools
    // (1, 10, ...) that are just noise.
    .filter((p) =>
      p.kind === "Classic" ? p.value >= 1 : p.assets.some((a) => a.amount > 0)
    )
    .sort((a, b) => b.value - a.value);

  // Fill in the true pair for one-sided vaults (label has no " / "): the current
  // decomposition holds a single token (e.g. an out-of-range Margined vault fully
  // in OSMO), so pull the underlying pool's token0/token1 by its pool id. Bounded
  // concurrency; failures leave the one-sided label unchanged.
  await mapLimit(
    vaultPositions.filter((p) => !p.label.includes(" / ") && p.poolRef),
    CONCURRENCY,
    async (p) => {
      const pair = await fetchPoolPairSymbols(p.poolRef as string, priceMap);
      if (pair) p.label = orderedPairLabel(pair[0], pair[1]);
    }
  );

  // Treasury-wide per-asset totals (across ALL holders) for the "By asset"
  // summary and the pie chart, plus the non-OSMO headline figure.
  const byAsset = aggregateBySymbol(
    holders.flatMap((h) =>
      h.assets.map((a) => ({
        symbol: a.symbol,
        info: "",
        amount: a.amount,
        value: a.value,
        denom: a.symbol,
        priceUnavailable: a.priceUnavailable,
      }))
    )
  );
  const nonOsmoValue = byAsset
    .filter((a) => !a.isOsmo)
    .reduce((s, a) => s + a.value, 0);

  // Union of every holder's unpriced symbols — a diagnostic kept in the payload,
  // but rendered per-holder in the UI (not on the top banner).
  const unpricedSymbols = [
    ...new Set(holders.flatMap((h) => h.unpricedSymbols)),
  ].sort((a, b) => a.localeCompare(b));

  // Sanity gate 1 (absolute floor): the main pool is always worth well over $1M;
  // a near-zero result means a broken price feed or LCD outage.
  if (!(mainTotal > 100_000)) {
    throw new Error(
      `Treasury snapshot main pool value implausibly low ($${mainTotal.toFixed(0)}); refusing to persist`
    );
  }

  // Sanity gate 2 (proportional move): reject a large swing vs the previous good
  // snapshot. Now that every position-fetch failure aborts instead of silently
  // dropping, a big drop would most likely be a subtler partial; this is the
  // backstop. Skipped on the first run (no previous value to compare).
  const prev = options.previousMainPoolValue;
  if (prev != null && prev > 0) {
    const move = Math.abs(mainTotal - prev) / prev;
    if (move > MAX_MAIN_POOL_MOVE) {
      throw new Error(
        `Treasury snapshot main pool moved ${(move * 100).toFixed(1)}% ` +
          `($${prev.toFixed(0)} -> $${mainTotal.toFixed(0)}), exceeding the ` +
          `${(MAX_MAIN_POOL_MOVE * 100).toFixed(0)}% guard; refusing to persist ` +
          `(likely a partial fetch). The previous snapshot is kept.`
      );
    }
  }

  logger.info(
    `Treasury snapshot: total $${totalValue.toFixed(0)} across ${holders.length} holders, ${unpricedSymbols.length} unpriced`
  );

  return {
    timestamp: new Date().toISOString(),
    totalValue,
    nonOsmoValue,
    mainPool: { totalValue: mainTotal, holdings: mainSorted },
    holders,
    byAsset,
    clPositions,
    vaultPositions,
    unpricedSymbols,
  };
}
