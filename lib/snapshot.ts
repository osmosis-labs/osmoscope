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
  fetchLatestBlock,
  BURN_ADDRESS,
  DEVELOPER_VESTING_MODULE_ADDRESS,
} from "./osmosis-lcd";
import {
  fetchBondedValidators,
  nakamotoCoefficient,
  giniCoefficient,
  fetchUnbondingSchedule,
  indexValidatorDaily,
  indexGovParticipation,
} from "./validators";
import { saveSnapshot, getHistory, backfillRevenue } from "./historical-file";
import { fetchDailyRevenue } from "./revenue";
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
// Exported for unit tests (pure function; the live path calls it internally).
export function assertSnapshotSane(metrics: {
  mintedSupply: number;
  totalSupply: number;
  burned: number;
  circulating: number;
  restrictedSupply: number;
  communitySupply: number;
  // Current snapshot's reversed dev-vesting offset (module-account balance). Used
  // to normalize a legacy prev row to the same raw-minted basis before the
  // day-over-day delta check (see below).
  devVestingSupply?: number;
  prev?: {
    totalSupply: number;
    restrictedSupply?: number;
    communitySupply?: number;
    // Absent on legacy rows written before the raw-minted-basis fix: those rows'
    // totalSupply is on the OFFSET-APPLIED basis (~1 dev-vesting balance lower).
    devVestingSupply?: number | null;
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
  // Dev-vesting module balance floor. The developer-vesting module account always
  // holds tens of millions of unvested OSMO on mainnet, so a zero reading means
  // fetchBalance failed (it returns 0 on a transient LCD error rather than
  // throwing). Persisting that would write mintedSupply/totalSupply on the
  // offset-applied basis AND stamp devVestingSupply: 0 — which the correction
  // script (WHERE devVestingSupply IS NULL) can never repair, and which makes the
  // NEXT run reject the ~55M basis gap and block the cron. Refuse here so the bad
  // row is never written. Guarded on !== undefined so backfill/tests that omit
  // the field are unaffected; the live path always supplies it.
  if (metrics.devVestingSupply !== undefined && !(metrics.devVestingSupply > 0))
    throw new SnapshotSanityError(
      `dev-vesting supply not positive (${metrics.devVestingSupply}) — likely a failed balance read`
    );

  // Day-over-day deltas vs. the previous snapshot.
  const prev = metrics.prev;
  if (prev) {
    // Normalize the prior row to THIS snapshot's basis before comparing. A legacy
    // row written before the raw-minted-basis fix (devVestingSupply absent) has a
    // totalSupply that is one dev-vesting balance lower purely as a methodology
    // artifact, not a real supply move. Comparing raw-minted (now) against
    // offset-applied (then) would show a ~55M jump and wrongly trip the gate on
    // the first post-deploy snapshot, before the one-off correction script runs.
    // Adding the current reversed offset to the legacy prev puts both on the raw
    // basis; a genuinely bad read still trips because the offset is ~constant.
    // Only normalize when we actually have a positive current offset to add — the
    // floor check above already rejects a zero/failed dev-vesting read on the live
    // path, so reaching here without one means a caller that doesn't supply it, in
    // which case leaving prev unnormalized is the safe (stricter) choice.
    const currentDevVesting = metrics.devVestingSupply ?? 0;
    const prevTotalSupply =
      prev.devVestingSupply == null && currentDevVesting > 0
        ? prev.totalSupply + currentDevVesting
        : prev.totalSupply;
    if (
      Math.abs(metrics.totalSupply - prevTotalSupply) > MAX_DAILY_SUPPLY_DELTA
    )
      throw new SnapshotSanityError(
        `total supply moved ${(metrics.totalSupply - prevTotalSupply).toFixed(0)} OSMO vs prior — implausible, refusing to persist`
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
    devVestingSupply: devVestingBalance,
    prev: prevSnapshot
      ? {
          totalSupply: prevSnapshot.totalSupply,
          restrictedSupply: prevSnapshot.restrictedSupply,
          communitySupply: prevSnapshot.communitySupply,
          devVestingSupply: prevSnapshot.devVestingSupply,
        }
      : undefined,
  });

  const timestamp = new Date().toISOString();

  const todayApr =
    aprData.entries.length > 0
      ? aprData.entries[aprData.entries.length - 1].apr
      : undefined;

  // Decentralization / network metrics (Nakamoto, Gini, pending undelegations,
  // block rate + height). These are analytics extras, NOT financial core, so the
  // whole block is best-effort: any failure leaves the fields undefined and the
  // snapshot still persists its supply data. Block rate is derived from the
  // height/time delta vs the previous snapshot (so it's a ~1-day average and
  // needs no archive node); the first snapshot after this ships has no prior
  // blockHeight and so leaves blockRate unset until the next day.
  let nakamoto: number | undefined;
  let gini: number | undefined;
  let pendingUndelegations: number | undefined;
  let blockRate: number | undefined;
  let blockHeight: number | undefined;
  try {
    const [validators, unbonding, latestBlock] = await Promise.all([
      fetchBondedValidators(),
      fetchUnbondingSchedule(),
      fetchLatestBlock(),
    ]);
    if (validators.length > 0) {
      nakamoto = nakamotoCoefficient(validators);
      gini = giniCoefficient(validators);
      // Self-index per-validator daily uptime + slash-event detection (feeds the
      // leaderboard's long-run uptime + slash columns going forward). Non-fatal.
      await indexValidatorDaily(validators);
      // Self-index governance participation: accumulate each validator's votes
      // (by-voter tx queries against the recent-index node) and score the
      // last-90-day window. Non-fatal; per-validator failures self-heal on the
      // next run.
      await indexGovParticipation(validators);
    }
    // pendingUndelegations on HistoricalRecord is the OUTSTANDING POOL total (a
    // stock). The per-day COMPLETING amounts (a flow) live in UndelegationDay,
    // written a day ahead (see below).
    blockHeight = latestBlock.height;

    // PERSIST GATE: if any validator's unbonding query failed, the total/days
    // are a plausible-looking UNDERCOUNT. Displaying that live is acceptable;
    // baking it into the permanent series (HistoricalRecord, the forecast blob,
    // tomorrow's UndelegationDay row) is not — same refuse-to-persist philosophy
    // as assertSnapshotSane. Leave the fields unset and let the 17:45 retry (or
    // tomorrow's run) fill them from a clean fan-out.
    if (unbonding.fetchFailures > 0) {
      logger.warn(
        `Unbonding fan-out had ${unbonding.fetchFailures} failed validator(s); ` +
          `skipping persistence of pending-undelegation figures this run.`
      );
    } else {
      pendingUndelegations = unbonding.total;

      // Persist the full forecast blob so /api/undelegations serves it from the DB
      // instead of re-running this ~71-call LCD fan-out on every page load (which the
      // public LCD rate-limits / 403s). This cron IS the once-a-day fan-out. Non-fatal.
      try {
        const { saveUnbondingForecast } = await import("./historical-file-db");
        await saveUnbondingForecast(unbonding, new Date());
      } catch (e) {
        logger.warn(
          `Unbonding forecast save skipped (non-critical): ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // Persist TOMORROW's completing amount into UndelegationDay, keyed to that
      // completion day. We read it today because the bucket is still full — reading
      // it on the day itself undercounts as entries complete through the day. Its
      // own table means the per-day HistoricalRecord delete-then-create can't clobber
      // this forward-dated value. Non-fatal: a failure here just leaves tomorrow's
      // point to be filled by tomorrow's run.
      try {
        const tomorrow = new Date(Date.now() + 86_400_000);
        const tomorrowIso = tomorrow.toISOString().slice(0, 10);
        const bucket = unbonding.days.find((d) => d.date === tomorrowIso);
        if (bucket) {
          const { upsertUndelegationDay } = await import(
            "./historical-file-db"
          );
          await upsertUndelegationDay(
            new Date(`${tomorrowIso}T00:00:00.000Z`),
            bucket.amount,
            "cron"
          );
        }
      } catch (e) {
        logger.warn(
          `UndelegationDay upsert skipped (non-critical): ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    // blockRate = elapsed seconds / blocks elapsed since the previous snapshot.
    const prevHeight = prevSnapshot?.blockHeight;
    if (prevHeight != null && latestBlock.height > prevHeight) {
      const prevTime = new Date(prevSnapshot!.timestamp).getTime();
      const elapsedSec =
        (new Date(latestBlock.time).getTime() - prevTime) / 1000;
      const blocks = latestBlock.height - prevHeight;
      if (elapsedSec > 0 && blocks > 0) blockRate = elapsedSec / blocks;
    }
  } catch (e) {
    logger.warn(
      `Network metrics skipped (non-critical): ${e instanceof Error ? e.message : String(e)}`
    );
  }

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
    // Decentralization / network metrics (best-effort; see above).
    nakamotoCoefficient: nakamoto,
    giniCoefficient: gini,
    pendingUndelegations,
    blockRate,
    blockHeight,
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

// Keep protocol-revenue fresh on existing rows. Data Lenses lags the chain by
// several days, so we can't attach "today's" revenue to a snapshot — instead we
// pull a short recent window and backfill any rows missing it or stale. As
// upstream publishes a new day, a later run fills it in.
//
// This is SEPARATE from buildAndSaveSnapshot on purpose: the cron often exits
// early (today's epoch snapshot already exists, or the epoch hasn't advanced)
// WITHOUT building a snapshot, and revenue must still refresh on those runs —
// otherwise it would only get one attempt per day (on the single epoch-advance
// tick), and a Data Lenses hiccup there would strand the gap for a full day. The
// cron calls this on EVERY invocation. Non-critical and fully guarded: a Data
// Lenses failure logs and returns 0, never throwing. Window = ~14 days, covering
// the ~5-day publish lag plus slack. Returns how many rows were filled.
export async function refreshRecentRevenue(): Promise<number> {
  try {
    const now = Date.now();
    const end = new Date(now).toISOString().split("T")[0];
    const start = new Date(now - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const revenue = await fetchDailyRevenue(start, end);
    const n = await backfillRevenue(revenue);
    if (n > 0) logger.info(`Revenue: filled ${n} recent row(s)`);
    return n;
  } catch (e) {
    logger.warn(
      `Revenue refresh skipped (non-critical): ${e instanceof Error ? e.message : String(e)}`
    );
    return 0;
  }
}
