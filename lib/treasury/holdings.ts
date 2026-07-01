// Holdings decomposition for the treasury engine. Given a price map and an
// address (or the community pool itself), produces a flat list of Holdings by
// unwinding every position type the pool/subDAOs hold: simple bank balances,
// GAMM classic-pool shares, Margined vaults, Magma vaults, concentrated-liquidity
// positions, and EVM (Ethereum) balances. Ported from the community-pool Apps
// Script. Server-only.
import { logger } from "../logger";
import {
  fetchLcdJson,
  fetchCosmwasmSmartData,
  fetchEvmNativeBalance,
  fetchErc20Balance,
} from "./fetch";
import type { PriceMap, PriceInfo } from "./prices";
import { fetchClPositions, clPositionToHoldings } from "./cl";
import {
  MAGMA_CONTRACTS,
  MAGMA_BALANCES_ARE_REVERSED,
  MAGMA_HOLDER_ADDRESS,
  EVM_NATIVE_ASSETS,
  EVM_TOKEN_ALLOWLIST,
  IGNORE_DENOMS,
} from "@/config/community-pool";

export interface Holding {
  symbol: string;
  info: string; // "Additional Info" column: pool/vault context
  amount: number;
  value: number; // USD; 0 when priceUnavailable
  denom: string;
  priceUnavailable: boolean; // true when no price was found — value is NOT trustworthy
}

const UNKNOWN_PRICE: PriceInfo = { symbol: "Unknown", price: 0, exponent: 0 };

function lookup(priceMap: PriceMap, denom: string): PriceInfo {
  return priceMap[denom] ?? UNKNOWN_PRICE;
}

// Find the best denom for a bare symbol (used by Magma, where the contract only
// gives us "USDC"/"BTC" strings, not denoms). Many bridged variants share a
// symbol and some are unpriced or MISpriced (e.g. one "USDC" variant reports
// $0.66 while the canonical ones report ~$1). Among positively-priced matches we
// pick the one whose price is the MEDIAN — robust to a single bad outlier, so a
// stray mispriced variant can't win. Falls back to any denom if none is priced;
// null if the symbol isn't in the map at all.
function bestDenomForSymbol(
  priceMap: PriceMap,
  symbol: string,
  caseInsensitive = false
): string | null {
  const want = caseInsensitive ? symbol.toUpperCase() : symbol;
  const symOf = (d: string) =>
    caseInsensitive ? priceMap[d].symbol.toUpperCase() : priceMap[d].symbol;
  const matches = Object.keys(priceMap).filter((d) => symOf(d) === want);
  if (matches.length === 0) return null;
  const priced = matches.filter((d) => priceMap[d].price > 0);
  if (priced.length === 0) return matches[0];
  // Sort by price and take the median denom (outlier-resistant).
  priced.sort((a, b) => priceMap[a].price - priceMap[b].price);
  return priced[Math.floor(priced.length / 2)];
}

// Build a holding from a raw (un-normalized) amount + denom, honoring the
// no-silent-zero rule: a missing price is flagged, not silently valued at 0.
function makeHolding(
  denom: string,
  rawAmount: number,
  priceMap: PriceMap,
  info: string,
  fallbackExponent?: number
): Holding {
  const p = lookup(priceMap, denom);
  const exponent = p.exponent || fallbackExponent || 0;
  const amount = rawAmount / Math.pow(10, exponent);
  const priceUnavailable = !(p.price > 0);
  return {
    symbol: p.symbol,
    info,
    amount,
    value: priceUnavailable ? 0 : amount * p.price,
    denom,
    priceUnavailable,
  };
}

// Recompute a holding's value/priceUnavailable from the (possibly updated) price
// map. Used after resolveMissingPrices() fills in held-but-unpriced denoms, so we
// don't have to re-fetch and re-decompose everything. `amount` is already in
// display units, so value = amount * price. Holdings whose denom isn't in the map
// (EVM synthetic denoms like "evm:1:0x…", which were valued by symbol, not denom)
// are returned unchanged — re-keying them by denom would wrongly zero them.
export function revalueHolding(h: Holding, priceMap: PriceMap): Holding {
  const p = priceMap[h.denom];
  if (!p) return h; // not a real Osmosis denom (e.g. EVM) — keep as valued
  const priceUnavailable = !(p.price > 0);
  return {
    ...h,
    symbol: p.symbol,
    value: priceUnavailable ? 0 : h.amount * p.price,
    priceUnavailable,
  };
}

// --- Standard bank holding -------------------------------------------------
function standardHolding(
  denom: string,
  rawAmount: number,
  priceMap: PriceMap,
  info = ""
): Holding {
  return makeHolding(denom, rawAmount, priceMap, info);
}

// --- GAMM classic-pool share -----------------------------------------------
async function gammHoldings(
  denom: string,
  rawAmount: number,
  priceMap: PriceMap
): Promise<Holding[]> {
  const poolId = denom.split("/").pop();
  // No catch: a failed pool query would silently drop this LP position's value.
  // Let the fetch error propagate so the snapshot aborts rather than undercount.
  const shares = await fetchLcdJson<{ total_shares: { amount: string } }>(
    `/osmosis/gamm/v1beta1/pools/${poolId}/total_shares`
  );
  const totalShares = parseFloat(shares.total_shares.amount);
  const liq = await fetchLcdJson<{
    liquidity: Array<{ denom: string; amount: string }>;
  }>(`/osmosis/gamm/v1beta1/pools/${poolId}/total_pool_liquidity`);

  return (liq.liquidity || []).map((asset) => {
    const userShare = (rawAmount / totalShares) * parseFloat(asset.amount);
    return makeHolding(
      asset.denom,
      userShare,
      priceMap,
      `Classic Pool ${poolId}`
    );
  });
}

// --- Margined vault (factory/<contract>/...vault...) -----------------------
async function marginedVaultHoldings(
  denom: string,
  rawAmount: number,
  priceMap: PriceMap
): Promise<Holding[] | null> {
  const parts = denom.split("/");
  const contractAddress = parts[1];
  const subdenom = parts.slice(2).join("/");
  if (!/vault/i.test(subdenom)) return null; // only known Margined vault tokens

  const vaultAmount = Math.floor(Number(rawAmount || 0));
  if (!vaultAmount || !contractAddress) return null;

  // This IS a known Margined vault token. A null/non-array result means the
  // estimate_vault_assets query failed after retries across every base. At least
  // one vault (locust-vault-2285) has a contract query that errors 500/502 on
  // ALL public nodes deterministically, so aborting the whole snapshot on it
  // would mean no snapshot ever completes. Per an explicit product decision we
  // DROP such a vault silently: return [] (an empty decomposition), NOT null.
  // Returning [] tells decomposeBankDenom this was a vault (so it must NOT fall
  // back to treating the unpriceable share token as a plain $0 balance, which
  // would pollute the unpriced list) but it contributed no valued holdings.
  const vaultData = await fetchCosmwasmSmartData<
    Array<{ denom: string; amount: string }>
  >(contractAddress, {
    vault_extension: {
      vaultenator: {
        estimate_vault_assets: { amount: vaultAmount.toString() },
      },
    },
  });
  if (!Array.isArray(vaultData)) {
    logger.warn(
      `Margined vault query failed for ${denom}; dropping this vault from the snapshot (silent per config)`
    );
    return [];
  }

  const info = subdenom
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return vaultData.map((v) =>
    makeHolding(v.denom, parseFloat(v.amount || "0"), priceMap, info)
  );
}

// --- Magma vaults ----------------------------------------------------------
// The holder's share of each Magma vault's bal0/bal1 is their underlying
// exposure. One contract stores balances reversed relative to the symbol order.
export async function magmaHoldings(
  address: string,
  priceMap: PriceMap
): Promise<Holding[]> {
  const holdings: Holding[] = [];

  for (const contract of MAGMA_CONTRACTS) {
    // No swallowing catch: a null from fetchCosmwasmSmartData means the query
    // failed after retries across every base, i.e. a sustained outage — not a
    // zero balance. Throwing here propagates to buildTreasurySnapshot and aborts,
    // so a transient CosmWasm outage can't silently drop a vault's value. A
    // genuine zero balance is handled explicitly below (continue), not by error.
    const balanceData = await fetchCosmwasmSmartData<{ balance?: string }>(
      contract,
      { balance: { address } }
    );
    if (balanceData === null) {
      throw new Error(`Magma balance query failed for ${contract}`);
    }
    const addressBalance = parseFloat(balanceData.balance || "0");
    // Genuine zero balance for this holder — nothing to add, move on.
    if (addressBalance === 0) continue;

    const tokenInfo = await fetchCosmwasmSmartData<{
      symbol?: string;
      total_supply?: string;
    }>(contract, { token_info: {} });
    if (tokenInfo === null) {
      throw new Error(`Magma token_info query failed for ${contract}`);
    }
    const totalSupply = parseFloat(tokenInfo.total_supply || "0");
    if (!totalSupply) continue;

    const [sym0, sym1] = String(tokenInfo.symbol || "").split("/");
    const label = `${tokenInfo.symbol} Magma`;

    const vaultData = await fetchCosmwasmSmartData<{
      bal0?: string;
      bal1?: string;
    }>(contract, { vault_balances: {} });
    if (vaultData === null) {
      throw new Error(`Magma vault_balances query failed for ${contract}`);
    }

    const userShare = addressBalance / totalSupply;
    const bal0 = parseFloat(vaultData.bal0 || "0");
    const bal1 = parseFloat(vaultData.bal1 || "0");
    const reversed = !!MAGMA_BALANCES_ARE_REVERSED[contract];
    const asset0Raw = (reversed ? bal1 : bal0) * userShare;
    const asset1Raw = (reversed ? bal0 : bal1) * userShare;

    for (const [sym, raw] of [
      [sym0, asset0Raw],
      [sym1, asset1Raw],
    ] as const) {
      const denom = bestDenomForSymbol(priceMap, sym);
      if (!denom) {
        logger.warn(`Magma ${label}: no denom for symbol "${sym}"`);
        continue;
      }
      holdings.push(makeHolding(denom, raw, priceMap, label));
    }
  }

  return holdings;
}

// --- Concentrated-liquidity positions for an address -----------------------
// Flat holdings for value aggregation, derived from the SAME structured fetch
// (fetchClPositions) the display cards use — one source of truth, so the summed
// value and the cards can't drift. The positions list endpoint already returns
// asset0/asset1 + rewards, so no per-position detail call is needed.
async function clPositionHoldings(
  address: string,
  priceMap: PriceMap
): Promise<Holding[]> {
  const positions = await fetchClPositions(address, priceMap);
  return positions.flatMap((p) => clPositionToHoldings(p));
}

// --- EVM (Ethereum) balances for a 0x... address ---------------------------
export async function evmHoldings(
  address: string,
  chainId: string,
  priceMap: PriceMap
): Promise<Holding[]> {
  const holdings: Holding[] = [];
  const native = EVM_NATIVE_ASSETS[chainId];
  // Reuse the same median-price, outlier-resistant selection as Magma so a
  // mispriced variant (e.g. a "USDC" at $0.66) can't win — the EVM path had the
  // same collision bug (ETH-address USDC was valued at $0.66).
  const priceBySymbol = (symbol: string): PriceInfo => {
    const denom = bestDenomForSymbol(priceMap, symbol, true);
    return denom ? priceMap[denom] : { symbol, price: 0, exponent: 0 };
  };

  // No swallowing catches below: fetchEvmRpc throws only after every RPC
  // endpoint has failed. Since this address (the Grants Program's Ethereum
  // treasury) is almost entirely stablecoins, silently dropping a balance would
  // be a large undercount, so let an RPC outage propagate and abort the snapshot.

  // Native ETH.
  if (native) {
    const amount = await fetchEvmNativeBalance(
      chainId,
      address,
      native.decimals
    );
    if (amount > 0) {
      const p = priceBySymbol(native.priceSymbol || native.symbol);
      const priceUnavailable = !(p.price > 0);
      holdings.push({
        symbol: native.symbol,
        info: "Ethereum",
        amount,
        value: priceUnavailable ? 0 : amount * p.price,
        denom: `evm:${chainId}:native`,
        priceUnavailable,
      });
    }
  }

  // Allowlisted ERC20s.
  for (const token of EVM_TOKEN_ALLOWLIST[chainId] || []) {
    const amount = await fetchErc20Balance(
      chainId,
      address,
      token.contract,
      token.decimals
    );
    if (amount <= 0) continue;
    const p = priceBySymbol(token.symbol);
    const priceUnavailable = !(p.price > 0);
    holdings.push({
      symbol: token.symbol,
      info: "Ethereum",
      amount,
      value: priceUnavailable ? 0 : amount * p.price,
      denom: `evm:${chainId}:${token.contract}`,
      priceUnavailable,
    });
  }

  return holdings;
}

// Route a single bank-balance denom through the right decomposition.
export async function decomposeBankDenom(
  denom: string,
  rawAmount: number,
  priceMap: PriceMap
): Promise<Holding[]> {
  if (denom.startsWith("gamm/pool/")) {
    return gammHoldings(denom, rawAmount, priceMap);
  }
  if (denom.startsWith("factory/")) {
    // null => not a Margined vault token, fall through to a standard balance.
    // A Holding[] (possibly EMPTY, when the vault query failed and was dropped)
    // => this WAS a vault; use it as-is, don't treat the share token as a plain
    // balance.
    const vault = await marginedVaultHoldings(denom, rawAmount, priceMap);
    if (vault !== null) return vault;
  }
  return [standardHolding(denom, rawAmount, priceMap)];
}

// Bank balances (with decomposition) + CL positions for an arbitrary address.
export async function addressHoldings(
  address: string,
  priceMap: PriceMap
): Promise<Holding[]> {
  const holdings: Holding[] = [];

  // No catch: a failed bank query would silently drop this address's entire
  // balance. Let it propagate so the snapshot aborts rather than undercount.
  const bank = await fetchLcdJson<{
    balances: Array<{ denom: string; amount: string }>;
  }>(`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=10000`);
  for (const item of bank.balances || []) {
    if (IGNORE_DENOMS.has(item.denom)) continue;
    holdings.push(
      ...(await decomposeBankDenom(
        item.denom,
        parseFloat(item.amount || "0"),
        priceMap
      ))
    );
  }

  holdings.push(...(await clPositionHoldings(address, priceMap)));

  // The BABY Liquidity address also holds Magma vault positions (BABY/USDC,
  // BABY/BTC). Ported from the sheet's per-address special case.
  if (address === MAGMA_HOLDER_ADDRESS) {
    holdings.push(...(await magmaHoldings(address, priceMap)));
  }

  return holdings;
}

export { gammHoldings, clPositionHoldings, standardHolding, makeHolding };

// --- Sorting / categorization ----------------------------------------------
function sortingPriority(symbol: string, info: string): number {
  if (/USDC|USDT|USDN|USDY/i.test(symbol)) return 1;
  if (/BTC/i.test(symbol)) return 2;
  if (/ETH/i.test(symbol)) return 3;
  if (/SOL/i.test(symbol)) return 4;
  if (!symbol || symbol === "Unknown") return 8;
  if (info && info.trim() !== "" && !symbol.includes("OSMO")) return 5;
  if (/OSMO|ION/i.test(symbol)) return 7;
  return 6;
}

export function sortHoldings(holdings: Holding[]): Holding[] {
  return [...holdings].sort((a, b) => {
    const pa = sortingPriority(a.symbol, a.info);
    const pb = sortingPriority(b.symbol, b.info);
    if (pa !== pb) return pa - pb;
    if (a.value !== b.value) return b.value - a.value;
    return a.symbol.localeCompare(b.symbol, undefined, { sensitivity: "base" });
  });
}
