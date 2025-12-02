import { logger } from "../../lib/logger";
import {
  queryArchiveNode,
  queryArchiveNodeWithFallback,
  getBlockHeightForDate,
  validateSupply,
} from "./archive-node";

// Known addresses
const BURN_ADDRESS = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmcn030";

const STATIC_LOCKED_ADDRESSES = [
  "osmo1vqy8rqqlydj9wkcyvct9zxl3hc4eqgu3d7hd9k",
  "osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00",
  "osmo1pvxhtre74l37p6y2rs2e8xyek75z7xlc7g2trt",
];

const STAKED_ADDRESS = "osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00";

// ===================================
// Types
// ===================================

export interface DistributionParams {
  staking: string;
  poolIncentives: string;
  developerRewards: string;
  communityPool: string;
}

export interface LockedBalances {
  liquid: Record<string, number>;
  staked: number;
  devVesting: Record<string, number>;
}

// ===================================
// 1. Minted Supply Fetcher
// ===================================

export async function fetchMintedSupply(date: string): Promise<number> {
  const height = await getBlockHeightForDate(date);

  const response = await queryArchiveNodeWithFallback<{
    amount: { denom: string; amount: string };
  }>("/cosmos/bank/v1beta1/supply/by_denom?denom=uosmo", date, height);

  if (!response) {
    logger.error(`Failed to fetch minted supply for ${date}`);
    return 0;
  }

  const uosmo = parseInt(response.amount.amount);
  const osmo = uosmo / 1_000_000;

  if (!validateSupply(osmo)) {
    logger.warn(`Invalid minted supply for ${date}: ${osmo}`);
  }

  return osmo;
}

// ===================================
// 2. Burned Supply Fetcher
// ===================================

export async function fetchBurnedSupply(date: string): Promise<number> {
  const height = await getBlockHeightForDate(date);

  try {
    const response = await queryArchiveNodeWithFallback<{
      balance: { denom: string; amount: string };
    }>(`/cosmos/bank/v1beta1/balances/${BURN_ADDRESS}/by_denom?denom=uosmo`, date, height);

    if (!response) {
      logger.warn(`Could not fetch burned supply for ${date}, assuming 0`);
      return 0;
    }

    const uosmo = parseInt(response.balance.amount);
    const osmo = uosmo / 1_000_000;

    return osmo;
  } catch (error) {
    // Before burn was enabled, balance might be 0 or endpoint might error
    logger.warn(`Could not fetch burned supply for ${date}, assuming 0:`, error);
    return 0;
  }
}

// ===================================
// 3. Developer Vesting Addresses Fetcher
// ===================================

export async function fetchDeveloperVestingAddresses(
  date: string,
  height: number
): Promise<string[]> {
  try {
    const response = await queryArchiveNodeWithFallback<{
      params: {
        weighted_developer_rewards_receivers: Array<{
          address: string;
          weight: string;
        }>;
      };
    }>("/osmosis/mint/v1beta1/params", date, height);

    if (!response) {
      logger.error(`Failed to fetch developer vesting addresses for ${date}`);
      return [];
    }

    const addresses =
      response.params.weighted_developer_rewards_receivers.map(
        (r) => r.address
      );
    return addresses;
  } catch (error) {
    logger.error(
      `Failed to fetch developer vesting addresses for ${date}:`,
      error
    );
    return [];
  }
}

// ===================================
// 4. Locked Addresses Fetcher
// ===================================

export async function fetchLockedBalances(
  date: string,
  height: number
): Promise<LockedBalances> {
  const liquidBalances: Record<string, number> = {};
  const devVestingBalances: Record<string, number> = {};

  // 1. Fetch developer vesting addresses (dynamic)
  const devAddresses = await fetchDeveloperVestingAddresses(date, height);
  logger.info(`Found ${devAddresses.length} developer vesting addresses`);

  // 2. Fetch liquid balance for each static locked address
  for (const address of STATIC_LOCKED_ADDRESSES) {
    try {
      const response = await queryArchiveNodeWithFallback<{
        balance: { denom: string; amount: string };
      }>(
        `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uosmo`,
        date,
        height
      );

      if (!response) {
        logger.warn(`Could not fetch balance for ${address}`);
        liquidBalances[address] = 0;
        continue;
      }

      const uosmo = parseInt(response.balance?.amount || "0");
      liquidBalances[address] = uosmo / 1_000_000;
    } catch (error) {
      logger.warn(`Could not fetch balance for ${address}:`, error);
      liquidBalances[address] = 0;
    }
  }

  // 3. Fetch liquid balance for each developer vesting address
  for (const address of devAddresses) {
    try {
      const response = await queryArchiveNodeWithFallback<{
        balance: { denom: string; amount: string };
      }>(
        `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uosmo`,
        date,
        height
      );

      if (!response) {
        logger.warn(`Could not fetch balance for dev address ${address}`);
        devVestingBalances[address] = 0;
        continue;
      }

      const uosmo = parseInt(response.balance?.amount || "0");
      devVestingBalances[address] = uosmo / 1_000_000;
    } catch (error) {
      logger.warn(`Could not fetch balance for dev address ${address}:`, error);
      devVestingBalances[address] = 0;
    }
  }

  // 4. Fetch staked balance for the staked address
  let stakedAmount = 0;
  try {
    const response = await queryArchiveNodeWithFallback<{
      delegation_responses: Array<{
        delegation: {
          delegator_address: string;
          validator_address: string;
          shares: string;
        };
        balance: { denom: string; amount: string };
      }>;
    }>(`/cosmos/staking/v1beta1/delegations/${STAKED_ADDRESS}`, date, height);

    if (!response) {
      logger.warn(`Could not fetch staked balance for ${date}`);
    } else {
      for (const delegation of response.delegation_responses || []) {
        const uosmo = parseInt(delegation.balance.amount);
        stakedAmount += uosmo / 1_000_000;
      }
    }
  } catch (error) {
    logger.warn(`Could not fetch staked balance for ${date}:`, error);
  }

  return {
    liquid: liquidBalances,
    staked: stakedAmount,
    devVesting: devVestingBalances,
  };
}

// ===================================
// 5. Community Pool Fetcher
// ===================================

export async function fetchCommunityPool(
  date: string,
  height: number
): Promise<number> {
  try {
    const response = await queryArchiveNodeWithFallback<{
      pool: Array<{ denom: string; amount: string }>;
    }>("/cosmos/distribution/v1beta1/community_pool", date, height);

    if (!response) {
      logger.warn(`Could not fetch community pool for ${date}`);
      return 0;
    }

    const osmoPool = response.pool.find((coin) => coin.denom === "uosmo");
    if (!osmoPool) return 0;

    // Community pool amounts are decimals with high precision
    const amount = parseFloat(osmoPool.amount);
    return amount / 1_000_000;
  } catch (error) {
    logger.warn(`Could not fetch community pool for ${date}:`, error);
    return 0;
  }
}

// ===================================
// 6. Distribution Parameters Fetcher
// ===================================

export async function fetchDistributionParams(
  date: string,
  height: number
): Promise<DistributionParams | null> {
  try {
    const response = await queryArchiveNodeWithFallback<{
      params: {
        mint_denom: string;
        genesis_epoch_provisions: string;
        epoch_identifier: string;
        reduction_period_in_epochs: string;
        reduction_factor: string;
        distribution_proportions: {
          staking: string;
          pool_incentives: string;
          developer_rewards: string;
          community_pool: string;
        };
        weighted_developer_rewards_receivers: Array<{
          address: string;
          weight: string;
        }>;
        minting_rewards_distribution_start_epoch: string;
      };
    }>("/osmosis/mint/v1beta1/params", date, height);

    if (!response) {
      logger.error(`Failed to fetch distribution params for ${date}`);
      throw new Error("Failed to fetch distribution params with fallback");
    }

    const props = response.params.distribution_proportions;

    // Validate proportions sum to 1.0
    const sum =
      parseFloat(props.staking) +
      parseFloat(props.pool_incentives) +
      parseFloat(props.developer_rewards) +
      parseFloat(props.community_pool);

    if (Math.abs(sum - 1.0) > 0.01) {
      logger.warn(
        `Distribution proportions don't sum to 1.0 for ${date}: ${sum}`
      );
    }

    return {
      staking: props.staking,
      poolIncentives: props.pool_incentives,
      developerRewards: props.developer_rewards,
      communityPool: props.community_pool,
    };
  } catch (error) {
    logger.error(`Failed to fetch distribution params for ${date}:`, error);
    return null;
  }
}

// ===================================
// 7. Epoch Provisions Fetcher
// ===================================

export async function fetchEpochProvisions(
  date: string,
  height: number
): Promise<number | null> {
  try {
    const response = await queryArchiveNodeWithFallback<{
      epoch_provisions: string;
    }>("/osmosis/mint/v1beta1/epoch_provisions", date, height);

    if (!response) {
      logger.error(`Failed to fetch epoch provisions for ${date}`);
      return null;
    }

    const uosmo = parseFloat(response.epoch_provisions);
    return uosmo / 1_000_000;
  } catch (error) {
    logger.error(`Failed to fetch epoch provisions for ${date}:`, error);
    return null;
  }
}

// ===================================
// 8. Total Staked Fetcher
// ===================================

export async function fetchTotalStaked(
  date: string,
  height: number
): Promise<number | null> {
  try {
    // Note: The staking pool endpoint doesn't work with historical heights
    // Instead, we query all bonded validators and sum their tokens
    let allValidators: Array<{
      operator_address: string;
      tokens: string;
      status: string;
    }> = [];
    let nextKey: string | null = null;

    // Import the new function that returns both data and height
    const { queryArchiveNodeWithFallbackAndHeight, queryArchiveNode } = await import("./archive-node");

    // Paginate through all bonded validators
    // First request: use fallback to find a working height
    const paginationParam = "";
    const firstResult = await queryArchiveNodeWithFallbackAndHeight<{
      validators: Array<{
        operator_address: string;
        tokens: string;
        status: string;
      }>;
      pagination: {
        next_key: string | null;
      };
    }>(
      `/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=100${paginationParam}`,
      date,
      height
    );

    if (!firstResult) {
      logger.error(`Failed to fetch validators for ${date}`);
      return null;
    }

    const effectiveHeight = firstResult.height;
    const firstResponse = firstResult.data;

    allValidators = allValidators.concat(firstResponse.validators);
    nextKey = firstResponse.pagination.next_key;

    // Continue pagination with regular queries using the EFFECTIVE height
    // (pagination keys are height-specific, must use same height throughout)
    while (nextKey) {
      const paginationParam = `&pagination.key=${encodeURIComponent(nextKey)}`;

      const { queryArchiveNode } = await import("./archive-node");
      const response = await queryArchiveNode<{
        validators: Array<{
          operator_address: string;
          tokens: string;
          status: string;
        }>;
        pagination: {
          next_key: string | null;
        };
      }>(
        `/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=100${paginationParam}`,
        effectiveHeight
      );

      allValidators = allValidators.concat(response.validators);
      nextKey = response.pagination.next_key;
    }

    // Sum all bonded validators' tokens
    const totalBondedTokens = allValidators.reduce((sum, validator) => {
      return sum + parseInt(validator.tokens);
    }, 0);

    logger.debug(
      `Total staked for ${date}: ${allValidators.length} validators, ${totalBondedTokens} uosmo`
    );

    return totalBondedTokens / 1_000_000;
  } catch (error) {
    logger.error(`Failed to fetch total staked for ${date}:`, error);
    return null;
  }
}
