// Builds a daily historical snapshot record from current chain state and
// persists it (via saveSnapshot, which dedupes per day). Extracted so both the
// scheduled cron route (/api/cron/snapshot) and any other caller share one
// definition of "what a snapshot contains".
import {
  fetchTotalSupply,
  fetchBalance,
  fetchCommunityPool,
  fetchRestrictedSupply,
  fetchInflation,
  fetchStakingApr,
  fetchFullMintParams,
  fetchPoolManagerParams,
  fetchTotalStaked,
  BURN_ADDRESS,
  DEVELOPER_VESTING_MODULE_ADDRESS,
} from "./osmosis-lcd";
import { saveSnapshot, getHistory } from "./historical-file";
import { logger } from "./logger";

export interface SnapshotResult {
  saved: boolean;
  timestamp: string;
  dayEpoch?: number;
}

// Thrown when a snapshot's freshly-fetched values look implausible (likely a
// partial fetch failure). We refuse to persist rather than bake bad financial
// data into the daily series. The caller surfaces this; the next cron retries.
export class SnapshotSanityError extends Error {}

// Reject a snapshot whose core supply figures are missing or move implausibly
// vs. the previous snapshot. Several fetchers (fetchBalance for burn/dev-vesting,
// fetchCommunityPool) return 0 on a transient LCD error instead of throwing, so a
// partial failure would otherwise be persisted as if it were clean. Mint adds at
// most ~0.5M OSMO/day and burn/community move slowly, so a day-over-day jump
// beyond a wide tolerance signals a bad read, not a real event.
const MAX_DAILY_SUPPLY_DELTA = 5_000_000; // OSMO; ~10x a generous daily mint
const MAX_DAILY_RESTRICTED_DELTA = 40_000_000; // OSMO; allows real unlock events
function assertSnapshotSane(metrics: {
  mintedSupply: number;
  totalSupply: number;
  burned: number;
  circulating: number;
  restrictedSupply: number;
  communitySupply: number;
  prev?: {
    totalSupply: number;
    restrictedSupply?: number;
    communitySupply?: number;
  };
}): void {
  // Absolute floors: supply can never be zero/negative on a live chain.
  if (!(metrics.mintedSupply > 0))
    throw new SnapshotSanityError(
      `minted supply not positive (${metrics.mintedSupply})`
    );
  if (!(metrics.totalSupply > 0))
    throw new SnapshotSanityError(
      `total supply not positive (${metrics.totalSupply})`
    );
  if (metrics.burned < 0)
    throw new SnapshotSanityError(`burned negative (${metrics.burned})`);
  if (metrics.restrictedSupply <= 0)
    throw new SnapshotSanityError(
      `restricted supply not positive (${metrics.restrictedSupply}) — likely a failed balance read`
    );
  if (metrics.communitySupply <= 0)
    throw new SnapshotSanityError(
      `community supply not positive (${metrics.communitySupply}) — likely a failed pool read`
    );
  if (metrics.circulating <= 0)
    throw new SnapshotSanityError(
      `circulating not positive (${metrics.circulating})`
    );

  // Day-over-day deltas vs. the previous snapshot.
  const prev = metrics.prev;
  if (prev) {
    if (
      Math.abs(metrics.totalSupply - prev.totalSupply) > MAX_DAILY_SUPPLY_DELTA
    )
      throw new SnapshotSanityError(
        `total supply moved ${(metrics.totalSupply - prev.totalSupply).toFixed(0)} OSMO vs prior — implausible, refusing to persist`
      );
    if (
      prev.restrictedSupply != null &&
      Math.abs(metrics.restrictedSupply - prev.restrictedSupply) >
        MAX_DAILY_RESTRICTED_DELTA
    )
      throw new SnapshotSanityError(
        `restricted supply moved ${(metrics.restrictedSupply - prev.restrictedSupply).toFixed(0)} OSMO vs prior — likely a failed read`
      );
  }
}

// Fetch current metrics LIVE and persist a snapshot. This is the ONE place that
// computes restricted supply live (the read-side endpoint reads it back from the
// snapshot), so the supply figures here must come from live chain state, not
// from a previously stored snapshot. `dayEpoch` is the verified current day-epoch
// number (the cron resolves it and gates on it advancing) and is stored on the
// record so the next run can tell whether the epoch has moved on.
export async function buildAndSaveSnapshot(
  dayEpoch?: number
): Promise<SnapshotResult> {
  const [
    mintedSupply,
    burnedAmount,
    communitySupply,
    restrictedEntities,
    devVestingBalance,
    inflationRate,
    aprData,
    mintParams,
    poolManagerParams,
    totalStaked,
  ] = await Promise.all([
    fetchTotalSupply(),
    fetchBalance(BURN_ADDRESS),
    fetchCommunityPool(),
    fetchRestrictedSupply(),
    fetchBalance(DEVELOPER_VESTING_MODULE_ADDRESS),
    fetchInflation(),
    fetchStakingApr(),
    fetchFullMintParams(),
    fetchPoolManagerParams(),
    fetchTotalStaked(),
  ]);

  // `fetchTotalSupply()` returns the chain's supply/by_denom value, which is
  // ALREADY offset-adjusted: the x/mint module registers a negative supply
  // offset equal to the unvested developer-vesting balance, so by_denom has that
  // ~55M OSMO removed. We reverse the offset to get RAW minted supply, matching
  // the canonical mint-module methodology (MTN-151 / the /total_supply +
  // /circulating_supply chain endpoints), which does all math on raw GetSupply.
  //
  // This is required for dev-vesting to be counted EXACTLY ONCE: raw minted
  // includes it (+), and restrictedSupply subtracts it (-), so it nets to zero
  // in circulating. Using the offset-applied by_denom here instead (its prior
  // behaviour) removed dev-vesting a SECOND time via restrictedSupply, which
  // understated both total and circulating by the dev-vesting balance (~55M).
  const rawMintedSupply = mintedSupply + devVestingBalance;
  const totalSupply = rawMintedSupply - burnedAmount;
  const restrictedSupply = restrictedEntities + devVestingBalance;
  const circulating = totalSupply - restrictedSupply - communitySupply;
  const metrics = {
    burned: burnedAmount,
    // Store RAW minted (offset reversed) so the identity
    // totalSupply === mintedSupply − burned holds for consumers of the record,
    // and mintedSupply matches the chain's raw GetSupply basis.
    mintedSupply: rawMintedSupply,
    totalSupply,
    circulating,
    restrictedSupply,
    communitySupply,
  };

  // Sanity-gate before persisting: refuse partial-failure snapshots (a fetcher
  // returning 0 on a transient error) rather than baking bad data into the series.
  // Compare against the latest COMPLETE prior row (greatest timestamp carrying
  // core supply), not just history[last]: a partial or out-of-order tail row
  // (e.g. a migrate upsert at an odd time, or a legacy duplicate-day row) would
  // otherwise seed a bad baseline and could trigger a false SnapshotSanityError
  // that blocks a valid daily snapshot. Mirrors the metrics route's "don't trust
  // array position" selection.
  const history = await getHistory();
  const prevSnapshot = history.reduce<(typeof history)[number] | undefined>(
    (best, r) => {
      if (r.totalSupply == null || r.mintedSupply == null) return best;
      if (!best) return r;
      return new Date(r.timestamp).getTime() >=
        new Date(best.timestamp).getTime()
        ? r
        : best;
    },
    undefined
  );
  assertSnapshotSane({
    ...metrics,
    prev: prevSnapshot
      ? {
          totalSupply: prevSnapshot.totalSupply,
          restrictedSupply: prevSnapshot.restrictedSupply,
          communitySupply: prevSnapshot.communitySupply,
        }
      : undefined,
  });

  const timestamp = new Date().toISOString();

  const todayApr =
    aprData.entries.length > 0
      ? aprData.entries[aprData.entries.length - 1].apr
      : undefined;

  const saved = await saveSnapshot({
    timestamp,
    dayEpoch,
    burnedSupply: metrics.burned,
    mintedSupply: metrics.mintedSupply,
    totalSupply: metrics.totalSupply,
    circulatingSupply: metrics.circulating,
    restrictedSupply: metrics.restrictedSupply,
    communitySupply: metrics.communitySupply,
    devVestingSupply: devVestingBalance,
    inflationRate,
    totalStaked,
    stakingApr: todayApr,
    stakingRate: aprData.average,
    distributionProportions: mintParams
      ? {
          staking: mintParams.distribution_proportions.staking,
          poolIncentives: mintParams.distribution_proportions.pool_incentives,
          developerRewards:
            mintParams.distribution_proportions.developer_rewards,
          communityPool: mintParams.distribution_proportions.community_pool,
        }
      : undefined,
    osmoTakerFeeDistribution: poolManagerParams
      ? {
          stakingRewards:
            poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
              .staking_rewards,
          communityPool:
            poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
              .community_pool,
          burn: poolManagerParams.taker_fee_params.osmo_taker_fee_distribution
            .burn,
        }
      : undefined,
    nonOsmoTakerFeeDistribution: poolManagerParams
      ? {
          stakingRewards:
            poolManagerParams.taker_fee_params.non_osmo_taker_fee_distribution
              .staking_rewards,
          communityPool:
            poolManagerParams.taker_fee_params.non_osmo_taker_fee_distribution
              .community_pool,
          burn: poolManagerParams.taker_fee_params
            .non_osmo_taker_fee_distribution.burn,
        }
      : undefined,
    communityPoolDenomWhitelist:
      poolManagerParams?.community_pool_denom_whitelist,
    communityPoolDenomToSwapNonWhitelistedAssetsTo:
      poolManagerParams?.taker_fee_params
        .community_pool_denom_to_swap_non_whitelisted_assets_to,
  });

  logger.info(
    saved
      ? `Snapshot persisted for ${timestamp}`
      : `Snapshot skipped (already captured) for ${timestamp}`
  );
  return { saved, timestamp, dayEpoch };
}
