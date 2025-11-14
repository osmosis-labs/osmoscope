// Osmosis LCD API Response Types

export interface SupplyResponse {
  amount: {
    denom: string;
    amount: string;
  };
}

export interface BalanceResponse {
  balances: Array<{
    denom: string;
    amount: string;
  }>;
  pagination?: {
    next_key: string | null;
    total: string;
  };
}

export interface CommunityPoolResponse {
  pool: Array<{
    denom: string;
    amount: string;
  }>;
}

export interface MintParamsResponse {
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
}

export interface InflationResponse {
  inflation: string;
}

export interface PoolManagerParamsResponse {
  params: {
    pool_creation_fee: Array<{
      denom: string;
      amount: string;
    }>;
    taker_fee_params: {
      default_taker_fee: string;
      osmo_taker_fee_distribution: {
        staking_rewards: string;
        community_pool: string;
        burn?: string;
      };
      non_osmo_taker_fee_distribution: {
        staking_rewards: string;
        community_pool: string;
        burn?: string;
      };
      admin_addresses: string[];
      community_pool_denom_to_swap_non_whitelisted_assets_to: string;
      reduced_fee_whitelist: string[];
    };
    authorized_quote_denoms: string[];
    community_pool_denom_whitelist?: string[];
  };
}

export interface DelegationResponse {
  delegation_responses: Array<{
    delegation: {
      delegator_address: string;
      validator_address: string;
      shares: string;
    };
    balance: {
      denom: string;
      amount: string;
    };
  }>;
  pagination?: {
    next_key: string | null;
    total: string;
  };
}

export interface StakingPoolResponse {
  pool: {
    not_bonded_tokens: string;
    bonded_tokens: string;
  };
}

// Numia API Response Types
export interface NumiaAprEntry {
  labels: string; // Date string like "2025-01-13 00:00:00.000"
  symbol: string; // "OSMO" or "total"
  apr: number;
}

export type NumiaAprResponse = NumiaAprEntry[];

// Processed data types for our dashboard
export interface OsmosisMetrics {
  burned: number; // OSMO in burn address
  mintedSupply: number; // Total minted supply
  totalSupply: number; // Minted supply - burned
  circulating: number; // Total supply - locked addresses
  restrictedSupply: number; // Modeled restricted supply (97046470)
  communitySupply: number; // Modeled community supply (89137083)
  inflationRate: number; // Current inflation rate
  burnRate: number; // Burn rate (change in burn address balance)
  netInflation: number; // Inflation rate + burn rate
  stakingApr: number; // 30-day average staking APR
  timestamp: string;
}

export interface TokenBalanceData {
  label: string;
  burned: number;
  totalSupply: number;
  circulating: number;
}

export interface InflationRateData {
  label: string;
  inflationRate: number;
  burnRate: number;
  netInflation: number;
}
