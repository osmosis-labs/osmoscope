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

// Helper to perform fetch with retry logic for rate limiting
async function fetchWithRetry(
  url: string,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      });

      // If we get a 429, wait and retry with exponential backoff
      if (response.status === 429) {
        const retryDelay = baseDelay * Math.pow(2, attempt);
        logger.warn(
          `Rate limited (429) for ${url}, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await delay(retryDelay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const retryDelay = baseDelay * Math.pow(2, attempt);
        logger.warn(
          `Request failed for ${url}, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`
        );
        await delay(retryDelay);
      }
    }
  }

  throw lastError || new Error(`Failed after ${maxRetries} retries`);
}

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
  await delay(200);

  const response = await fetchWithRetry(url);

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

// Restricted (non-circulating) wallet set, mirrored from the chain's own
// supply methodology in osmosis/x/mint/types/restricted_addresses.go.
// Source of truth is that compiled-in constant; keep this list in sync when it
// changes. Composition: the foundation / strategic-reserve address plus the
// original genesis developer-rewards receivers (now collapsed out of mint
// params). For each, BOTH the liquid balance and the staked (delegated) amount
// are excluded, since staked OSMO held by a restricted entity is not part of
// the public float. The CURRENT weighted_developer_rewards_receivers entry is
// intentionally NOT listed here: it is fetched separately from mint params and
// de-duplicated in fetchRestrictedSupply, matching the keeper's param loop.
export const RESTRICTED_ADDRESSES = [
  // Foundation / strategic reserve.
  "osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00",
  // Original genesis developer-rewards receivers (no longer in mint params).
  "osmo14kjcwdwcqsujkdt8n5qwpd8x8ty2rys5rjrdjj",
  "osmo1gw445ta0aqn26suz2rg3tkqfpxnq2hs224d7gq",
  "osmo13lt0hzc6u3htsk7z5rs6vuurmgg4hh2ecgxqkf",
  "osmo1kvc3he93ygc0us3ycslwlv2gdqry4ta73vk9hu",
  "osmo19qgldlsk7hdv3ddtwwpvzff30pxqe9phq9evxf",
  "osmo19fs55cx4594een7qr8tglrjtt5h9jrxg458htd",
  "osmo1ssp6px3fs3kwreles3ft6c07mfvj89a544yj9k",
  "osmo1c5yu8498yzqte9cmfv5zcgtl07lhpjrj0skqdx",
  "osmo1yhj3r9t9vw7qgeg22cehfzj7enwgklw5k5v7lj",
  "osmo18nzmtyn5vy5y45dmcdnta8askldyvehx66lqgm",
  "osmo1z2x9z58cg96ujvhvu6ga07yv9edq2mvkxpgwmc",
  "osmo1tvf3373skua8e6480eyy38avv8mw3hnt8jcxg9",
  "osmo1zs0txy03pv5crj2rvty8wemd3zhrka2ne8u05n",
  "osmo1djgf9p53n7m5a55hcn6gg0cm5mue4r5g3fadee",
  "osmo1488zldkrn8xcjh3z40v2mexq7d088qkna8ceze",
];

// Compute the restricted (non-circulating) OSMO held by known foundation,
// strategic-reserve, and developer-reward entities: liquid balance + staked
// amount for each, summed. The current mint-param dev-rewards receiver is added
// on top and de-duplicated against RESTRICTED_ADDRESSES so it is never counted
// twice (mirrors GetRestrictedSupply in the mint keeper). Community pool and the
// developer-vesting module account are handled separately by the caller, so they
// are NOT included here.
export async function fetchRestrictedSupply(): Promise<number> {
  // Param dev-rewards receivers, de-duplicated against the static list.
  const paramReceivers = await fetchMintParams();
  const seen = new Set(RESTRICTED_ADDRESSES);
  const extraReceivers = paramReceivers.filter((a) => !seen.has(a));
  const addresses = [...RESTRICTED_ADDRESSES, ...extraReceivers];

  // Sequential to respect the same rate-limit posture as the rest of the lib.
  let total = 0;
  for (const addr of addresses) {
    const liquid = await fetchBalance(addr);
    const staked = await fetchDelegations(addr);
    total += liquid + staked;
  }
  return total;
}

// Developer-vesting module account ("developer_vesting_unvested"). Holds OSMO
// minted to the developer-rewards pool that has not yet vested out to receivers.
// Verified via cosmos/auth/v1beta1/module_accounts. The chain's supply
// methodology excludes this from circulating supply, so we count it as
// restricted.
export const DEVELOPER_VESTING_MODULE_ADDRESS =
  "osmo1vqy8rqqlydj9wkcyvct9zxl3hc4eqgu3d7hd9k";

// Calculate all metrics.
//
// Circulating (public float) follows the chain's own methodology
// (mint keeper GetCirculatingSupply): circulating = total - restricted, where
// restricted = developer-vesting module balance + community pool + the
// restricted address set (liquid + staked). Osmometer keeps restricted and
// community as separate reported columns, so restrictedSupply below EXCLUDES the
// community pool (reported separately) but INCLUDES the dev-vesting module, and
// circulating is computed as total - restricted - community to reconcile.
export async function calculateOsmosisMetrics() {
  try {
    // Fetch critical data first.
    const [mintedSupply, burnedAmount, inflationRate] = await Promise.all([
      fetchTotalSupply(),
      fetchBalance(BURN_ADDRESS),
      fetchInflation(),
    ]);

    // Community pool, dev-vesting module balance, and the restricted entity set.
    const [communitySupply, devVestingBalance, restrictedEntities] =
      await Promise.all([
        fetchCommunityPool(),
        fetchBalance(DEVELOPER_VESTING_MODULE_ADDRESS),
        fetchRestrictedSupply(),
      ]);

    // Total supply (minted - burned). Burn is the balance sitting at the burn
    // address; it is removed from supply.
    const totalSupply = mintedSupply - burnedAmount;

    // Restricted supply excludes the community pool (reported separately) and
    // includes the still-unvested developer-vesting module balance.
    const restrictedSupply = restrictedEntities + devVestingBalance;

    // Circulating supply (public float).
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
