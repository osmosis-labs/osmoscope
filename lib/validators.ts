// Validator / decentralization analytics, sourced from the Osmosis staking and
// slashing LCD modules. Powers the Nakamoto coefficient, Gini coefficient,
// voting-power distribution, validator leaderboard, and pending-undelegation
// figures. All current-state (a single live query); historical series come from
// the snapshot cron recording these over time. Server-only (reuses the
// osmosis-lcd fetch/cache layer).
import { cachedFetch, LCD_BASE_URL, uosmoToOsmo } from "./osmosis-lcd";
import { logger } from "./logger";
import { bech32 } from "bech32";
import { createHash } from "crypto";

// One bonded validator, normalized. `tokens` is bonded OSMO (display units).
export interface ValidatorInfo {
  operatorAddress: string; // osmovaloper1…
  moniker: string;
  tokens: number; // bonded OSMO
  commission: number; // 0-1 (current rate)
  jailed: boolean;
  // Fraction of total bonded stake this validator holds (0-1). Filled after the
  // full set is fetched so it's consistent across the set.
  votingPowerShare: number;
  // Uptime over the slashing signed-blocks window (0-1), or null if the
  // signing-info couldn't be joined. Filled by fetchValidatorUptime.
  uptime: number | null;
  // Snapshot metrics from the ValidatorSnapshot table (SmartStake import), joined
  // by operator address. Null when no snapshot row exists. These are point-in-time
  // (see snapshotAsOf), not live.
  govVotesLast10: number | null; // votes in the last 10 proposals (0-10)
  timesSlashed: number | null;
  longRunUptime: number | null; // long-run signing uptime % (0-100)
}

// Raw LCD shapes (only the fields we use).
interface RawValidator {
  operator_address: string;
  jailed: boolean;
  status: string;
  tokens: string; // uosmo
  description: { moniker: string };
  commission: { commission_rates: { rate: string } };
  consensus_pubkey: { "@type": string; key: string }; // ed25519, base64
}
interface ValidatorsResponse {
  validators: RawValidator[];
  pagination: { next_key: string | null };
}

// Fetch the full BONDED validator set, following pagination. Bonded-only because
// the active set is what determines voting power / decentralization; jailed or
// unbonded validators hold no consensus power. Sorted by stake desc.
export async function fetchBondedValidators(): Promise<ValidatorInfo[]> {
  const out: ValidatorInfo[] = [];
  let key: string | null = null;
  // Guard against an unbounded loop if the endpoint misbehaves — the active set
  // is ~150, so a handful of 100-item pages is the ceiling.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      "pagination.limit": "100",
      status: "BOND_STATUS_BONDED",
    });
    if (key) params.set("pagination.key", key);
    const data: ValidatorsResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/staking/v1beta1/validators?${params.toString()}`,
      true // long cache: the set changes at most once per epoch
    );
    for (const v of data.validators) {
      const info: ValidatorInfo = {
        operatorAddress: v.operator_address,
        moniker: v.description?.moniker?.trim() || v.operator_address,
        tokens: uosmoToOsmo(v.tokens),
        commission: Number(v.commission?.commission_rates?.rate ?? 0),
        jailed: v.jailed,
        votingPowerShare: 0, // set below
        uptime: null, // set by enrichWithUptime
        govVotesLast10: null, // set by enrichWithSnapshot
        timesSlashed: null,
        longRunUptime: null,
      };
      out.push(info);
      // Track the consensus address (for the uptime join) in a side map keyed by
      // operator address, so ValidatorInfo stays clean / JSON-serializable.
      const pubkey = v.consensus_pubkey?.key;
      if (pubkey) {
        try {
          consAddressByOperator.set(
            v.operator_address,
            consensusAddressFromPubkey(pubkey)
          );
        } catch {
          /* skip: can't derive, uptime will be null for this validator */
        }
      }
    }
    key = data.pagination?.next_key ?? null;
    if (!key) break;
  }

  const total = out.reduce((s, v) => s + v.tokens, 0);
  for (const v of out) v.votingPowerShare = total > 0 ? v.tokens / total : 0;
  out.sort((a, b) => b.tokens - a.tokens);
  return out;
}

// operatorAddress -> consensus address, populated by fetchBondedValidators for
// the uptime join. Module-scoped and overwritten each fetch; the validator set
// is small (~70) so this never grows unbounded.
const consAddressByOperator = new Map<string, string>();

// A validator's consensus address (osmovalcons1…), derived from its ed25519
// consensus pubkey: sha256(pubkey)[:20] then bech32 with the osmovalcons prefix.
// This is the key the slashing signing_infos are stored under (validators
// otherwise only expose the pubkey), so it's needed to join uptime.
function consensusAddressFromPubkey(pubkeyBase64: string): string {
  const raw = Buffer.from(pubkeyBase64, "base64");
  const hash = createHash("sha256").update(raw).digest().subarray(0, 20);
  return bech32.encode("osmovalcons", bech32.toWords(hash));
}

interface SigningInfo {
  address: string; // consensus address (osmovalcons1…)
  missed_blocks_counter: string;
}
interface SigningInfosResponse {
  info: SigningInfo[];
  pagination: { next_key: string | null };
}
interface SlashingParamsResponse {
  params: { signed_blocks_window: string };
}

// Enrich validators in-place with uptime over the slashing signed-blocks window:
// uptime = 1 − missed_blocks_counter / signed_blocks_window, joined via the
// derived consensus address. Non-fatal: if slashing data can't be fetched, every
// validator's uptime stays null (the leaderboard just omits the column value).
async function enrichWithUptime(validators: ValidatorInfo[]): Promise<void> {
  try {
    const paramsResp: SlashingParamsResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/slashing/v1beta1/params`,
      true
    );
    const window = Number(paramsResp.params?.signed_blocks_window) || 0;
    if (window <= 0) return;

    // Build a consensus-address -> missed-count map, paginating signing_infos.
    const missedByAddr = new Map<string, number>();
    let key: string | null = null;
    for (let page = 0; page < 20; page++) {
      const p = new URLSearchParams({ "pagination.limit": "500" });
      if (key) p.set("pagination.key", key);
      const data: SigningInfosResponse = await cachedFetch(
        `${LCD_BASE_URL}/cosmos/slashing/v1beta1/signing_infos?${p.toString()}`,
        false
      );
      for (const s of data.info)
        missedByAddr.set(s.address, Number(s.missed_blocks_counter) || 0);
      key = data.pagination?.next_key ?? null;
      if (!key) break;
    }

    for (const v of validators) {
      const consAddr = consAddressByOperator.get(v.operatorAddress);
      if (!consAddr) continue;
      const missed = missedByAddr.get(consAddr);
      if (missed === undefined) continue;
      v.uptime = Math.max(0, Math.min(1, 1 - missed / window));
    }
  } catch (error) {
    logger.warn(
      `Uptime enrichment skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Join the ValidatorSnapshot table (imported from SmartStake's Validators.csv)
// onto the live set by operator address, filling govVotesLast10 / timesSlashed /
// longRunUptime. Returns the snapshot's "as of" time (max updatedAt) so the UI can
// label it point-in-time. Non-fatal / DB-optional: if the table is empty or the
// DB isn't reachable, the fields stay null and asOf is null.
async function enrichWithSnapshot(
  validators: ValidatorInfo[]
): Promise<string | null> {
  try {
    // Imported lazily so lib/validators stays usable without a DB (the live
    // metrics don't need it); the snapshot join is a best-effort overlay.
    const { prisma, isDatabaseEnabled } = await import("./database");
    if (!isDatabaseEnabled()) return null;
    const snaps = await prisma.validatorSnapshot.findMany();
    if (snaps.length === 0) return null;
    const byOp = new Map(snaps.map((s) => [s.operatorAddress, s]));
    let asOf: Date | null = null;
    for (const v of validators) {
      const s = byOp.get(v.operatorAddress);
      if (!s) continue;
      v.govVotesLast10 = s.govVotesLast10 ?? null;
      v.timesSlashed = s.timesSlashed ?? null;
      v.longRunUptime =
        s.longRunUptime == null ? null : Number(s.longRunUptime);
      if (s.updatedAt && (!asOf || s.updatedAt > asOf)) asOf = s.updatedAt;
    }
    return asOf ? asOf.toISOString() : null;
  } catch (error) {
    logger.warn(
      `Snapshot enrichment skipped: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

// Nakamoto coefficient: the minimum number of validators whose combined stake
// exceeds the Byzantine-fault threshold (>1/3 of bonded stake), i.e. the smallest
// colluding set that could halt the chain. Lower = more centralized. Expects a
// stake-desc-sorted set (fetchBondedValidators guarantees it).
export function nakamotoCoefficient(validators: ValidatorInfo[]): number {
  const total = validators.reduce((s, v) => s + v.tokens, 0);
  if (total <= 0) return 0;
  const threshold = total / 3; // >1/3 halts consensus
  let cumulative = 0;
  let count = 0;
  for (const v of validators) {
    cumulative += v.tokens;
    count++;
    if (cumulative > threshold) break;
  }
  return count;
}

// Gini coefficient of stake concentration across the validator set (0 = perfectly
// even, 1 = maximally concentrated). Complements Nakamoto: Nakamoto is only about
// the top tail, Gini describes the whole distribution's inequality. Uses the
// standard mean-absolute-difference formulation over stake values.
export function giniCoefficient(validators: ValidatorInfo[]): number {
  const values = validators.map((v) => v.tokens).filter((t) => t > 0);
  const n = values.length;
  if (n === 0) return 0;
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  values.sort((a, b) => a - b); // ascending for the ranked formula
  // G = (2·Σ i·x_i) / (n·Σ x_i) − (n+1)/n, with i 1-indexed.
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * values[i];
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

// Aggregate staking pool: bonded vs. currently-unbonding OSMO. `notBonded` is the
// total pending-undelegation amount across the whole chain (no per-delegator
// enumeration needed).
export interface StakingPool {
  bonded: number;
  notBonded: number;
}
export async function fetchStakingPool(): Promise<StakingPool> {
  const data: { pool: { bonded_tokens: string; not_bonded_tokens: string } } =
    await cachedFetch(`${LCD_BASE_URL}/cosmos/staking/v1beta1/pool`, true);
  return {
    bonded: uosmoToOsmo(data.pool.bonded_tokens),
    notBonded: uosmoToOsmo(data.pool.not_bonded_tokens),
  };
}

// Decentralization snapshot: the derived metrics plus the set they came from.
export interface DecentralizationMetrics {
  validatorCount: number;
  nakamoto: number;
  gini: number;
  bondedTotal: number;
  validators: ValidatorInfo[];
  // ISO time the per-validator snapshot (gov/slashing/long-run-uptime) was last
  // imported, or null if no snapshot is present. The UI shows it as an "as of".
  snapshotAsOf: string | null;
}

export async function fetchDecentralizationMetrics(): Promise<DecentralizationMetrics> {
  try {
    const validators = await fetchBondedValidators();
    // Uptime (live LCD) and the snapshot overlay (DB) are independent; run both.
    const [, snapshotAsOf] = await Promise.all([
      enrichWithUptime(validators),
      enrichWithSnapshot(validators),
    ]);
    return {
      validatorCount: validators.length,
      nakamoto: nakamotoCoefficient(validators),
      gini: giniCoefficient(validators),
      bondedTotal: validators.reduce((s, v) => s + v.tokens, 0),
      validators,
      snapshotAsOf,
    };
  } catch (error) {
    logger.error("Error fetching decentralization metrics:", error);
    throw new Error("Failed to fetch decentralization metrics");
  }
}

// ---------------------------------------------------------------------------
// Unbonding (pending undelegations) schedule.
//
// IMPORTANT: `staking/pool.not_bonded_tokens` is NOT the pending-undelegation
// total — on Osmosis it's ~25x too high (it also holds superfluid / module
// balances). The true figure is the sum of actual unbonding_delegations entries.
// There is no aggregate endpoint, so we enumerate per bonded validator and bucket
// each entry by its completion day. ~13s across the set, so this is cached / cron-
// driven, never a hot per-request path.
// ---------------------------------------------------------------------------

// Bounded-concurrency map so we don't fire ~70 LCD calls at once (rate limits).
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

interface UnbondingResponse {
  unbonding_responses: {
    entries: { completion_time: string; balance: string }[];
  }[];
}

// One day's total OSMO completing unbonding on that date (UTC, YYYY-MM-DD).
export interface UnbondingDay {
  date: string;
  amount: number;
}
export interface UnbondingSchedule {
  total: number; // true chain-wide unbonding total (OSMO)
  days: UnbondingDay[]; // per-completion-day, ascending
}

// Enumerate unbonding delegations across all bonded validators and bucket the
// entries by completion day. Returns the full schedule (all future completion
// days) plus the true total; the UI slices to the next N days.
export async function fetchUnbondingSchedule(): Promise<UnbondingSchedule> {
  const validators = await fetchBondedValidators();
  const byDay = new Map<string, number>();
  let total = 0;

  await mapLimit(validators, 6, async (v) => {
    try {
      const data: UnbondingResponse = await cachedFetch(
        `${LCD_BASE_URL}/cosmos/staking/v1beta1/validators/${v.operatorAddress}/unbonding_delegations?pagination.limit=1000`,
        false // short cache: unbonding changes continuously
      );
      for (const r of data.unbonding_responses ?? []) {
        for (const e of r.entries ?? []) {
          const day = e.completion_time.slice(0, 10);
          const amt = uosmoToOsmo(e.balance);
          byDay.set(day, (byDay.get(day) ?? 0) + amt);
          total += amt;
        }
      }
    } catch (error) {
      // A single validator's endpoint failing shouldn't void the whole schedule;
      // log and continue (the total is then a slight undercount for this run).
      logger.warn(
        `Unbonding fetch failed for ${v.operatorAddress}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  const days = [...byDay.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { total, days };
}
