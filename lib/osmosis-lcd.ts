import { LRUCache } from "lru-cache";
import { logger } from "./logger";
import type {
  SupplyResponse,
  CommunityPoolResponse,
  MintParamsResponse,
  InflationResponse,
  DelegationResponse,
  NumiaAprResponse,
  NumiaAprEntry,
  PoolManagerParamsResponse,
  StakingPoolResponse,
} from "@/types/osmosis";

const LCD_BASE_URL =
  process.env.NEXT_PUBLIC_LCD_BASE_URL || "https://lcd.osmosis.zone";
const NUMIA_API_URL =
  process.env.NUMIA_API_URL || "https://public-osmosis-api.numia.xyz";
const NUMIA_API_KEY = process.env.NUMIA_API_KEY;

// Helper to add delay between requests
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// LRU cache with size limit to prevent memory leaks
// Short cache: For data that changes frequently (currently unused, kept for future use)
// Long cache: For data that changes once per day (supply, inflation, balances, staking pool, params)
const CACHE_TTL_SHORT = 30_000; // 30 seconds for frequently changing data
const CACHE_TTL_LONG = 24 * 60 * 60 * 1000; // 24 hours for daily-changing data

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shortCache = new LRUCache<string, any>({
  max: 50, // Maximum 50 entries
  ttl: CACHE_TTL_SHORT,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const longCache = new LRUCache<string, any>({
  max: 100, // Maximum 100 entries
  ttl: CACHE_TTL_LONG,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cachedFetch(url: string, useLongCache = false): Promise<any> {
  const cache = useLongCache ? longCache : shortCache;

  // Check cache (has built-in TTL)
  const cached = cache.get(url);
  if (cached !== undefined) {
    return cached;
  }

  // Add small delay to avoid rate limiting
  await delay(100);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    // Don't cache errors
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Cache the response (LRU will handle eviction and TTL)
  cache.set(url, data);

  return data;
}

// Convert uosmo to OSMO (1 OSMO = 1,000,000 uosmo)
export function uosmoToOsmo(uosmo: string | number): number {
  return Number(uosmo) / 1_000_000;
}

// Fetch total supply of OSMO
// Use long cache since supply only changes once a day
export async function fetchTotalSupply(): Promise<number> {
  try {
    const data: SupplyResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/bank/v1beta1/supply/by_denom?denom=uosmo`,
      true // Use long cache (24 hours)
    );
    return uosmoToOsmo(data.amount.amount);
  } catch (error) {
    logger.error("Error fetching total supply:", error);
    throw new Error(`Failed to fetch supply`);
  }
}

// Fetch balance of a specific address (for OSMO only)
// Use long cache since these balances rarely change (once a day at most)
export async function fetchBalance(address: string): Promise<number> {
  try {
    const data: { balance: { denom: string; amount: string } } =
      await cachedFetch(
        `${LCD_BASE_URL}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uosmo`,
        true // Use long cache (24 hours)
      );
    return data.balance ? uosmoToOsmo(data.balance.amount) : 0;
  } catch (error) {
    logger.error(`Error fetching balance for ${address}:`, error);
    // Return 0 instead of throwing to allow partial data fetch
    return 0;
  }
}

// Fetch staked/delegated balance of a specific address
// Use long cache since delegations rarely change (once a day at most)
export async function fetchDelegations(address: string): Promise<number> {
  try {
    const data: DelegationResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/staking/v1beta1/delegations/${address}`,
      true // Use long cache (24 hours)
    );

    // Sum up all delegations
    const totalStaked = data.delegation_responses.reduce((sum, delegation) => {
      if (delegation.balance.denom === "uosmo") {
        return sum + parseFloat(delegation.balance.amount);
      }
      return sum;
    }, 0);

    return uosmoToOsmo(totalStaked);
  } catch (error) {
    logger.error(`Error fetching delegations for ${address}:`, error);
    // Return 0 instead of throwing to allow partial data fetch
    return 0;
  }
}

// Fetch community pool balance
// Use long cache since community pool rarely changes significantly
export async function fetchCommunityPool(): Promise<number> {
  try {
    const data: CommunityPoolResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/distribution/v1beta1/community_pool`,
      true // Use long cache (24 hours)
    );
    const osmoInPool = data.pool.find((coin) => coin.denom === "uosmo");
    return osmoInPool ? uosmoToOsmo(osmoInPool.amount) : 0;
  } catch (error) {
    logger.error("Error fetching community pool:", error);
    return 0;
  }
}

// Fetch mint params to get developer reward addresses
export async function fetchMintParams(): Promise<string[]> {
  try {
    const data: MintParamsResponse = await cachedFetch(
      `${LCD_BASE_URL}/osmosis/mint/v1beta1/params`
    );
    return data.params.weighted_developer_rewards_receivers.map(
      (r) => r.address
    );
  } catch (error) {
    logger.error("Error fetching mint params:", error);
    return [];
  }
}

// Fetch full mint params including distribution proportions
// Use long cache since params rarely change
export async function fetchFullMintParams(): Promise<
  MintParamsResponse["params"] | null
> {
  try {
    const data: MintParamsResponse = await cachedFetch(
      `${LCD_BASE_URL}/osmosis/mint/v1beta1/params`,
      true // Use long cache (24 hours)
    );
    return data.params;
  } catch (error) {
    logger.error("Error fetching full mint params:", error);
    return null;
  }
}

// Fetch pool manager params for taker fee distribution
// Use long cache since params rarely change
export async function fetchPoolManagerParams(): Promise<
  PoolManagerParamsResponse["params"] | null
> {
  try {
    const data: PoolManagerParamsResponse = await cachedFetch(
      `${LCD_BASE_URL}/osmosis/poolmanager/v1beta1/Params`,
      true // Use long cache (24 hours)
    );
    return data.params;
  } catch (error) {
    logger.error("Error fetching pool manager params:", error);
    return null;
  }
}

// Fetch current inflation rate
// Use long cache since inflation only changes once a day
export async function fetchInflation(): Promise<number> {
  try {
    const data: InflationResponse = await cachedFetch(
      `${LCD_BASE_URL}/osmosis/mint/v1beta1/inflation`,
      true // Use long cache (24 hours)
    );
    // Convert from string decimal (e.g., "0.185000000000000000") to percentage
    return parseFloat(data.inflation) * 100;
  } catch (error) {
    logger.error("Error fetching inflation:", error);
    throw new Error(`Failed to fetch inflation`);
  }
}

// Fetch total bonded tokens (staked OSMO)
// Use long cache since staking pool only changes once a day
export async function fetchTotalStaked(): Promise<number> {
  try {
    const data: StakingPoolResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/staking/v1beta1/pool`,
      true // Use long cache (24 hours)
    );
    return uosmoToOsmo(data.pool.bonded_tokens);
  } catch (error) {
    logger.error("Error fetching staking pool:", error);
    throw new Error(`Failed to fetch total staked`);
  }
}

// Fetch staking APR from Numia API (30-day average)
export async function fetchStakingApr(): Promise<{
  average: number;
  entries: NumiaAprEntry[];
}> {
  try {
    // Calculate date range for last 30 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const formatDate = (date: Date) => {
      return date.toISOString().split("T")[0]; // Format: YYYY-MM-DD
    };

    const url = `${NUMIA_API_URL}/apr?start_date=${formatDate(startDate)}&end_date=${formatDate(endDate)}`;

    const headers: HeadersInit = {
      Accept: "application/json",
    };

    // Add Authorization header if API key is configured
    if (NUMIA_API_KEY) {
      headers.Authorization = `Bearer ${NUMIA_API_KEY}`;
    }

    const response = await fetch(url, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const data: NumiaAprResponse = await response.json();

    // Filter for OSMO entries only (or use "total" if OSMO not available)
    const osmoEntries = data.filter(
      (entry) => entry.symbol === "OSMO" || entry.symbol === "total"
    );

    // Remove duplicates by date (keep one entry per day)
    const uniqueEntries = new Map<string, NumiaAprEntry>();
    osmoEntries.forEach((entry) => {
      const date = entry.labels.split(" ")[0]; // Extract date part
      if (!uniqueEntries.has(date)) {
        uniqueEntries.set(date, entry);
      }
    });

    const entries = Array.from(uniqueEntries.values());

    // Calculate 30-day average
    if (entries.length === 0) {
      logger.warn("No APR data available");
      return { average: 0, entries: [] };
    }

    const sum = entries.reduce((total, entry) => total + entry.apr, 0);
    const average = sum / entries.length;

    logger.info(
      `Calculated ${entries.length}-day average APR: ${average.toFixed(2)}%`
    );

    return { average, entries };
  } catch (error) {
    logger.error("Error fetching staking APR:", error);
    // Return 0 instead of throwing to allow other metrics to be fetched
    return { average: 0, entries: [] };
  }
}

// Known addresses to exclude from circulating supply
export const BURN_ADDRESS = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmcn030";
export const LOCKED_ADDRESSES = [
  "osmo1vqy8rqqlydj9wkcyvct9zxl3hc4eqgu3d7hd9k",
  "osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00",
];
// Address that also needs staked balance excluded from circulating
export const STAKED_ADDRESS = "osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00";

// Modeled supply values (until we have historical data sources)
export const MODELED_COMMUNITY_SUPPLY = 89137083;
export const MODELED_RESTRICTED_SUPPLY = 97046470;

// Calculate all metrics
export async function calculateOsmosisMetrics() {
  try {
    // Fetch critical data first
    const [mintedSupply, burnedAmount, inflationRate] = await Promise.all([
      fetchTotalSupply(),
      fetchBalance(BURN_ADDRESS),
      fetchInflation(),
    ]);

    // Fetch locked addresses balances in parallel (kept for future use)
    const _lockedBalances = await Promise.all(
      LOCKED_ADDRESSES.map((addr) => fetchBalance(addr))
    );

    // Fetch staked balance, community pool, and dev addresses in parallel (kept for future use)
    const [_stakedBalance, _communityPoolAmount, devAddresses] =
      await Promise.all([
        fetchDelegations(STAKED_ADDRESS),
        fetchCommunityPool(),
        fetchMintParams(),
      ]);

    // Fetch developer balances in parallel (kept for future use)
    const _devBalances = await Promise.all(
      devAddresses.map((addr) => fetchBalance(addr))
    );

    // Calculate total supply (minted - burned)
    const totalSupply = mintedSupply - burnedAmount;

    // Use modeled values for restricted and community supply
    const restrictedSupply = MODELED_RESTRICTED_SUPPLY;
    const communitySupply = MODELED_COMMUNITY_SUPPLY;

    // Calculate circulating supply (total - restricted - community)
    const circulating = totalSupply - restrictedSupply - communitySupply;

    return {
      burned: burnedAmount,
      totalSupply: totalSupply,
      circulating: circulating,
      inflationRate: inflationRate,
      mintedSupply: mintedSupply,
      restrictedSupply: restrictedSupply,
      communitySupply: communitySupply,
    };
  } catch (error) {
    logger.error("Error calculating Osmosis metrics:", error);
    throw error;
  }
}
