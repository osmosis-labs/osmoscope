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
  try {
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
  } catch (e) {
    logger.warn(`GAMM query error for ${denom}: ${(e as Error).message}`);
    return [];
  }
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

  try {
    const vaultData = await fetchCosmwasmSmartData<
      Array<{ denom: string; amount: string }>
    >(contractAddress, {
      vault_extension: {
        vaultenator: {
          estimate_vault_assets: { amount: vaultAmount.toString() },
        },
      },
    });
    if (!Array.isArray(vaultData)) return null;

    const info = subdenom
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return vaultData.map((v) =>
      makeHolding(v.denom, parseFloat(v.amount || "0"), priceMap, info)
    );
  } catch (e) {
    logger.warn(`Vault query error for ${denom}: ${(e as Error).message}`);
    return null;
  }
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
    try {
      // A null result = the fetch failed after retries across all bases. Treat
      // that as an ERROR (throw), never as a zero balance — silently coercing a
      // failed read to 0 would drop the whole vault and undercount the treasury.
      const balanceData = await fetchCosmwasmSmartData<{ balance?: string }>(
        contract,
        { balance: { address } }
      );
      if (balanceData === null) {
        throw new Error(`balance query failed for ${contract}`);
      }
      const addressBalance = parseFloat(balanceData.balance || "0");
      // Genuine zero balance for this holder — nothing to add, move on.
      if (addressBalance === 0) continue;

      const tokenInfo = await fetchCosmwasmSmartData<{
        symbol?: string;
        total_supply?: string;
      }>(contract, { token_info: {} });
      if (tokenInfo === null) {
        throw new Error(`token_info query failed for ${contract}`);
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
        throw new Error(`vault_balances query failed for ${contract}`);
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
    } catch (e) {
      logger.warn(
        `Magma error for ${address} on ${contract}: ${(e as Error).message}`
      );
    }
  }

  return holdings;
}

// --- Concentrated-liquidity positions for an address -----------------------
async function clPositionHoldings(
  address: string,
  priceMap: PriceMap,
  infoPrefix = "CL Pool"
): Promise<Holding[]> {
  const holdings: Holding[] = [];
  try {
    const posList = await fetchLcdJson<{
      positions: Array<{ position: { position_id: string; pool_id: string } }>;
    }>(`/osmosis/concentratedliquidity/v1beta1/positions/${address}`);

    for (const pos of posList.positions || []) {
      const { position_id: positionId, pool_id: poolId } = pos.position;
      try {
        const detail = await fetchLcdJson<{
          position: {
            asset0?: { denom: string; amount: string };
            asset1?: { denom: string; amount: string };
          };
        }>(
          `/osmosis/concentratedliquidity/v1beta1/position_by_id?position_id=${positionId}`
        );
        for (const asset of [detail.position.asset0, detail.position.asset1]) {
          if (asset?.denom && asset.amount) {
            holdings.push(
              makeHolding(
                asset.denom,
                parseFloat(asset.amount),
                priceMap,
                `${infoPrefix} - ${poolId}`
              )
            );
          }
        }
      } catch (e) {
        logger.warn(
          `CL position ${positionId} detail error: ${(e as Error).message}`
        );
      }
    }
  } catch (e) {
    logger.warn(`CL positions error for ${address}: ${(e as Error).message}`);
  }
  return holdings;
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

  // Native ETH.
  if (native) {
    try {
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
    } catch (e) {
      logger.warn(`EVM native balance error: ${(e as Error).message}`);
    }
  }

  // Allowlisted ERC20s.
  for (const token of EVM_TOKEN_ALLOWLIST[chainId] || []) {
    try {
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
    } catch (e) {
      logger.warn(
        `ERC20 balance error for ${token.symbol}: ${(e as Error).message}`
      );
    }
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
    const vault = await marginedVaultHoldings(denom, rawAmount, priceMap);
    if (vault) return vault;
  }
  return [standardHolding(denom, rawAmount, priceMap)];
}

// Bank balances (with decomposition) + CL positions for an arbitrary address.
export async function addressHoldings(
  address: string,
  priceMap: PriceMap
): Promise<Holding[]> {
  const holdings: Holding[] = [];

  try {
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
  } catch (e) {
    logger.warn(`Bank balances error for ${address}: ${(e as Error).message}`);
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
