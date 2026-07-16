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
  govVotesLast10: number | null; // votes in the last 10 proposals (0-10) — SmartStake import, fallback
  govVotedRecent: number | null; // proposals voted on out of the last-90-day set (self-computed)
  govRecentWindow: number | null; // size of that 90-day proposal set (the denominator)
  timesSlashed: number | null;
  latestSlashedTime: string | null; // ISO time of the most recent slash, or null
  longRunUptime: number | null; // long-run signing uptime % (0-100)
  selfBondPercentage: number | null; // validator's self-bond as % of its stake (SmartStake import)
  website: string | null; // validator's self-declared website (onchain description), or null
}

// Raw LCD shapes (only the fields we use).
interface RawValidator {
  operator_address: string;
  jailed: boolean;
  status: string;
  tokens: string; // uosmo
  description: { moniker: string; website?: string };
  commission: { commission_rates: { rate: string } };
  consensus_pubkey: { "@type": string; key: string }; // ed25519, base64
}
interface ValidatorsResponse {
  validators: RawValidator[];
  pagination: { next_key: string | null };
}

// Normalize a validator's self-declared website from the onchain description:
// trim, drop empties, and prefix a scheme when missing so the value is a valid
// href. Rejects anything that isn't http(s) after normalization (some validators
// put a bare handle or junk in the field) so we never render a broken/unsafe link.
function normalizeWebsite(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Require a dotted hostname so "https://foo" (no TLD) or "https://localhost"
    // junk doesn't slip through as a link.
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
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
      // Short cache: set MEMBERSHIP changes at most once per epoch, but each
      // validator's `tokens` (stake → voting power, Nakamoto, Gini) moves with
      // every delegation. A 24h cache on a warm lambda served day-old voting
      // power as "live"; the /api/validators edge cache (300s) already bounds
      // how often this refetches.
      false
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
        govVotedRecent: null,
        govRecentWindow: null,
        timesSlashed: null,
        latestSlashedTime: null,
        longRunUptime: null,
        selfBondPercentage: null,
        website: normalizeWebsite(v.description?.website),
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

// A validator's account address (osmo1…) from its operator address
// (osmovaloper1…). They share the same underlying 20-byte key — only the bech32
// prefix differs — so re-encoding the operator's data words with the "osmo"
// prefix yields the account validators cast governance votes from (verified:
// every voting validator among the 70 bonded — 65 — has onchain votes from
// this account; config/gov-voter-overrides.ts is the escape hatch should one
// ever vote from elsewhere). Returns null if the operator address can't be
// decoded.
export function accountAddressFromOperator(operator: string): string | null {
  try {
    const { words } = bech32.decode(operator);
    return bech32.encode("osmo", words);
  } catch {
    return null;
  }
}

interface SigningInfo {
  address: string; // consensus address (osmovalcons1…)
  missed_blocks_counter: string;
  jailed_until: string; // ISO; epoch-zero (1970) when never jailed
  tombstoned: boolean;
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

// Self-index per-validator daily data (called once a day by the snapshot cron):
//   1. Write today's slashing-window uptime (0-1) to ValidatorDaily per validator
//      — the leaderboard's long-run uptime is the trailing-90 average of these.
//   2. Detect slash events by comparing each validator's jailed_until / tombstoned
//      against the last-seen state stored on ValidatorSnapshot; on a NEW jailing
//      (jailed_until advanced) or a tombstone, bump cronSlashCount + record the time.
// BONDED-SET ONLY, by design: the leaderboard shows bonded validators, so slash
// state is observed for them alone. A validator jailed at cron time is out of the
// bonded set and its transition is picked up on RETURN (jailed_until advanced vs
// the stored baseline); one that never returns (quit, or tombstoned for
// double-signing) is not re-observed and its final event is not counted. Tracking
// the full signing_infos set would need a consensus→operator map for unbonded
// validators (not derivable from the bonded fetch) — deliberately out of scope.
// DB-optional and non-fatal: skips cleanly without a DB and logs on error. Reuses
// the consensus-address map populated by fetchBondedValidators (call after it).
export async function indexValidatorDaily(
  validators: ValidatorInfo[]
): Promise<void> {
  try {
    const { prisma, isDatabaseEnabled } = await import("./database");
    if (!isDatabaseEnabled()) return;

    const paramsResp: SlashingParamsResponse = await cachedFetch(
      `${LCD_BASE_URL}/cosmos/slashing/v1beta1/params`,
      true
    );
    const window = Number(paramsResp.params?.signed_blocks_window) || 0;
    if (window <= 0) return;

    // consensus address -> signing info (uptime inputs + slash state).
    const infoByAddr = new Map<string, SigningInfo>();
    let key: string | null = null;
    for (let page = 0; page < 20; page++) {
      const p = new URLSearchParams({ "pagination.limit": "500" });
      if (key) p.set("pagination.key", key);
      const data: SigningInfosResponse = await cachedFetch(
        `${LCD_BASE_URL}/cosmos/slashing/v1beta1/signing_infos?${p.toString()}`,
        false
      );
      for (const s of data.info) infoByAddr.set(s.address, s);
      key = data.pagination?.next_key ?? null;
      if (!key) break;
    }

    // UTC midnight for today's ValidatorDaily key.
    const now = new Date();
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    // Existing snapshot rows carry the last-seen slash state (for transition
    // detection). Load once, keyed by operator.
    const snaps = await prisma.validatorSnapshot.findMany();
    const snapByOp = new Map(snaps.map((s) => [s.operatorAddress, s]));

    for (const v of validators) {
      const consAddr = consAddressByOperator.get(v.operatorAddress);
      const info = consAddr ? infoByAddr.get(consAddr) : undefined;
      if (!info) continue;

      // 1. Daily uptime row (idempotent per operator+day).
      const missed = Number(info.missed_blocks_counter) || 0;
      const uptime = Math.max(0, Math.min(1, 1 - missed / window));
      await prisma.validatorDaily.upsert({
        where: {
          operatorAddress_date: {
            operatorAddress: v.operatorAddress,
            date: day,
          },
        },
        create: { operatorAddress: v.operatorAddress, date: day, uptime },
        update: { uptime },
      });

      // 2. Slash-transition detection vs last-seen state.
      const jailedUntil = new Date(info.jailed_until);
      const jailedValid = !isNaN(jailedUntil.getTime());
      const tombstoned = !!info.tombstoned;
      const prev = snapByOp.get(v.operatorAddress);
      const prevJailed = prev?.prevJailedUntil ?? null;
      const prevTomb = prev?.prevTombstoned ?? null;
      // FIRST observation of this validator (we've never recorded its jailed/
      // tombstone state): SEED the baseline, do NOT count a slash. Otherwise every
      // validator carrying an OLD jailed_until (from a slash months ago) would be
      // falsely flagged as slashed "today" on the first cron run. A slash is only
      // counted on a genuine transition from a known prior state.
      const firstObservation = prevJailed == null && prevTomb == null;
      // A new jailing = jailed_until advanced past the last-seen value; a new
      // tombstone = tombstoned flipped true. Either is a slash event. A null
      // baseline means "never jailed when last seen" (stored as null, time 0),
      // so a validator's FIRST-ever jailing still counts once seeded — only the
      // firstObservation guard below suppresses counting, never this comparison.
      const newJailing =
        jailedValid &&
        jailedUntil.getTime() > 0 &&
        jailedUntil.getTime() > (prevJailed?.getTime() ?? 0);
      const newTombstone = tombstoned && prevTomb === false;
      const slashed = !firstObservation && (newJailing || newTombstone);

      const data: {
        prevJailedUntil: Date | null;
        prevTombstoned: boolean;
        cronSlashCount?: number;
        cronLastSlashTime?: Date;
      } = {
        prevJailedUntil:
          jailedValid && jailedUntil.getTime() > 0 ? jailedUntil : null,
        prevTombstoned: tombstoned,
      };
      if (slashed) {
        // Plain set, NOT { increment: 1 }: rows created by the CSV import leave
        // cronSlashCount NULL, and in SQL NULL + 1 = NULL — an increment there
        // would silently discard every detected event. prev is already loaded,
        // so compute the new count in JS.
        data.cronSlashCount = (prev?.cronSlashCount ?? 0) + 1;
        data.cronLastSlashTime = now;
      }
      // Upsert so validators without a SmartStake row still get slash tracking.
      await prisma.validatorSnapshot.upsert({
        where: { operatorAddress: v.operatorAddress },
        create: {
          operatorAddress: v.operatorAddress,
          prevJailedUntil: data.prevJailedUntil,
          prevTombstoned: data.prevTombstoned,
          cronSlashCount: slashed ? 1 : 0,
          cronLastSlashTime: slashed ? now : null,
        },
        update: data,
      });
    }
  } catch (error) {
    logger.warn(
      `Validator daily indexing skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Self-index validator governance participation (called once a day by the
// snapshot cron, AFTER the financial snapshot has been persisted — this
// fan-out must never cost the day's supply row):
//   1. ACCUMULATE: query each validator's voting account BY VOTER and union
//      any new proposal ids into ValidatorVote (insert-only). Already-seeded
//      operators query only the recent-index node; an operator with NO
//      accumulated rows yet (newly bonded validator, or a just-identified
//      override account) is first-seeded from the archive AND the recent node,
//      because the recent index's floor (~60 days) sits inside the 90-day
//      window. scripts/backfill-validator-votes.ts did the same union for the
//      initial population. Per-validator failures are non-fatal and
//      self-healing — the next run re-queries the same window.
//   2. SCORE: govVotedRecent = |accumulated set ∩ proposals decided in the last
//      90 days|, govRecentWindow = window size; upserted on ValidatorSnapshot.
// The voting account is the operator-derived account (osmo1… with the same key)
// unless config/gov-voter-overrides.ts says otherwise; a null override means the
// voter is known to differ but unidentified, so the score is cleared to null
// rather than shown as a wrong 0. DB-optional and non-fatal.
export async function indexGovParticipation(
  validators: ValidatorInfo[]
): Promise<void> {
  try {
    const { prisma, isDatabaseEnabled } = await import("./database");
    if (!isDatabaseEnabled()) return;
    const {
      fetchRecentlyEndedProposals,
      fetchVoterProposalIds,
      RECENT_LCD,
      ARCHIVE_LCD,
    } = await import("./governance");
    const { GOV_VOTER_OVERRIDES } = await import(
      "../config/gov-voter-overrides"
    );

    const windowIds = new Set(await fetchRecentlyEndedProposals(Date.now()));
    // Nothing decided in the window — leave prior values untouched (a >90-day
    // gov quiet spell would otherwise clear real scores; implausible on
    // Osmosis, but the guard is free).
    if (windowIds.size === 0) return;

    // Which operators already have accumulated votes. A never-seeded operator
    // (newly bonded validator, or a null override whose voter account was just
    // identified) must be seeded from BOTH sources: the recent node's tx index
    // only reaches ~60 days back, inside the 90-day window, so recent-only
    // first-seeding would score a confident wrong-low number.
    const seeded = new Set(
      (
        await prisma.validatorVote.groupBy({
          by: ["operatorAddress"],
        })
      ).map((g) => g.operatorAddress)
    );

    // 1. Accumulate new votes, a few validators at a time (the nodes tolerate
    //    light concurrency; failures just defer to tomorrow — for a first-seed
    //    validator a PARTIAL union isn't persisted as "seeded" wrongly, because
    //    a source failure throws before any insert for that validator).
    await mapLimit(validators, 3, async (v) => {
      const override = GOV_VOTER_OVERRIDES[v.operatorAddress];
      if (override === null) return; // known-unknown voter: nothing to query
      const account = override ?? accountAddressFromOperator(v.operatorAddress);
      if (!account) return;
      try {
        const sources = seeded.has(v.operatorAddress)
          ? [RECENT_LCD]
          : [ARCHIVE_LCD, RECENT_LCD];
        const ids = new Set<number>();
        for (const source of sources) {
          for (const id of await fetchVoterProposalIds(account, source)) {
            ids.add(id);
          }
        }
        if (ids.size > 0) {
          await prisma.validatorVote.createMany({
            data: [...ids].map((proposalId) => ({
              operatorAddress: v.operatorAddress,
              proposalId,
            })),
            skipDuplicates: true,
          });
        }
      } catch (e) {
        logger.warn(
          `Gov vote fetch failed for ${v.moniker}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    });

    // 2. Score every validator from the accumulated sets. The window
    //    intersection happens in the query; the ~70 upserts run as one
    //    transaction so a mid-loop failure can't leave half the set scored
    //    against the new window and half against yesterday's.
    const votes = await prisma.validatorVote.findMany({
      where: { proposalId: { in: [...windowIds] } },
      select: { operatorAddress: true, proposalId: true },
    });
    const votedByOp = new Map<string, number>();
    for (const r of votes) {
      votedByOp.set(
        r.operatorAddress,
        (votedByOp.get(r.operatorAddress) ?? 0) + 1
      );
    }
    // Interactive (callback) form: the array form's default 5s transaction
    // timeout is NOT overridable and ~70 upserts over a remote connection take
    // longer — the whole score rolled back when tried (observed live). The
    // callback form accepts real headroom; the cron runs this once a day.
    await prisma.$transaction(
      async (tx) => {
        for (const v of validators) {
          const unknownVoter = GOV_VOTER_OVERRIDES[v.operatorAddress] === null;
          const data = {
            govVotedRecent: unknownVoter
              ? null
              : (votedByOp.get(v.operatorAddress) ?? 0),
            govRecentWindow: unknownVoter ? null : windowIds.size,
          };
          await tx.validatorSnapshot.upsert({
            where: { operatorAddress: v.operatorAddress },
            create: { operatorAddress: v.operatorAddress, ...data },
            update: data,
          });
        }
      },
      { timeout: 60_000, maxWait: 10_000 }
    );
  } catch (error) {
    logger.warn(
      `Gov participation indexing skipped: ${error instanceof Error ? error.message : String(error)}`
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
    const byOp = new Map(snaps.map((s) => [s.operatorAddress, s]));

    // Self-indexed long-run uptime: trailing-90-day average of ValidatorDaily.
    // Computed per operator over the last 90 rows; falls back to the SmartStake
    // longRunUptime for validators with no accrued daily history yet.
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const daily = await prisma.validatorDaily.findMany({
      where: { date: { gte: cutoff } },
      orderBy: { date: "asc" },
      select: { operatorAddress: true, uptime: true },
    });
    const dailyByOp = new Map<string, number[]>();
    for (const d of daily) {
      const arr = dailyByOp.get(d.operatorAddress) ?? [];
      arr.push(Number(d.uptime));
      dailyByOp.set(d.operatorAddress, arr);
    }

    if (snaps.length === 0 && daily.length === 0) return null;

    let asOf: Date | null = null;
    for (const v of validators) {
      const s = byOp.get(v.operatorAddress);
      // Governance: the self-computed last-90-day participation (indexed daily by
      // indexGovParticipation) is the primary metric; the SmartStake
      // govVotesLast10 import remains as a fallback for display before the first
      // index run.
      v.govVotesLast10 = s?.govVotesLast10 ?? null;
      v.govVotedRecent = s?.govVotedRecent ?? null;
      v.govRecentWindow = s?.govRecentWindow ?? null;
      // Slash count: prefer the SmartStake historical count as a baseline plus any
      // cron-detected events since; when no import exists, use the cron count alone.
      const importCount = s?.timesSlashed ?? null;
      const cronCount = s?.cronSlashCount ?? null;
      v.timesSlashed =
        importCount == null && cronCount == null
          ? null
          : (importCount ?? 0) + (cronCount ?? 0);
      // Last slash date: the later of the SmartStake import time and any
      // cron-detected slash.
      const importSlash = s?.latestSlashedTime ?? null;
      const cronSlash = s?.cronLastSlashTime ?? null;
      const latest =
        importSlash && cronSlash
          ? importSlash.getTime() >= cronSlash.getTime()
            ? importSlash
            : cronSlash
          : (importSlash ?? cronSlash);
      v.latestSlashedTime = latest ? latest.toISOString() : null;
      v.selfBondPercentage =
        s?.selfBondPercentage == null ? null : Number(s.selfBondPercentage);
      // Long-run uptime: trailing-90 self-indexed average once enough daily
      // readings have accrued; until then, keep the SmartStake import. Without
      // the minimum-sample floor, the column labelled "last 90 days" would
      // become a 1-day figure the day after the first cron run and only slowly
      // grow back into its label.
      const MIN_UPTIME_READINGS = 14;
      const readings = dailyByOp.get(v.operatorAddress);
      const importUptime =
        s?.longRunUptime == null ? null : Number(s.longRunUptime);
      if (
        readings &&
        (readings.length >= MIN_UPTIME_READINGS || importUptime == null)
      ) {
        const avg = readings.reduce((sum, u) => sum + u, 0) / readings.length;
        v.longRunUptime = avg * 100; // stored 0-1 → displayed %
      } else {
        v.longRunUptime = importUptime;
      }
      if (s?.updatedAt && (!asOf || s.updatedAt > asOf)) asOf = s.updatedAt;
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
    delegator_address: string;
    validator_address: string;
    entries: { completion_time: string; balance: string }[];
  }[];
  pagination?: { next_key: string | null };
}

// One day's total OSMO completing unbonding on that date (UTC, YYYY-MM-DD).
export interface UnbondingDay {
  date: string;
  amount: number;
}
// A single unbonding entry (one delegator's undelegation from one validator,
// completing at a specific time). Surfaced for the "Top undelegations" table.
export interface UnbondingEntry {
  delegator: string; // osmo1… delegator address
  validator: string; // osmovaloper1… validator address
  moniker: string; // validator moniker (resolved from the bonded set)
  amount: number; // OSMO in this entry
  completionTime: string; // ISO completion time
}
export interface UnbondingSchedule {
  total: number; // true chain-wide unbonding total (OSMO)
  days: UnbondingDay[]; // per-completion-day, ascending
  // The largest individual unbonding entries (amount desc), capped so the
  // payload stays bounded. Powers the Top Undelegations table.
  topEntries: UnbondingEntry[];
  // How many validators' unbonding queries FAILED this run. When > 0 the total
  // and days are an undercount: fine to display live (better than nothing), but
  // the snapshot cron refuses to PERSIST such a run into the historical series.
  fetchFailures: number;
}

// How many of the largest individual entries to return for the table.
const TOP_UNBONDING_ENTRIES = 50;

// Enumerate unbonding delegations across all bonded validators and bucket the
// entries by completion day. Returns the full schedule (all future completion
// days) plus the true total; the UI slices to the next N days.
export async function fetchUnbondingSchedule(): Promise<UnbondingSchedule> {
  const validators = await fetchBondedValidators();
  const monikerByOperator = new Map(
    validators.map((v) => [v.operatorAddress, v.moniker])
  );
  const byDay = new Map<string, number>();
  const entries: UnbondingEntry[] = [];
  let total = 0;
  let fetchFailures = 0;

  await mapLimit(validators, 6, async (v) => {
    try {
      // Follow pagination: a validator with >1000 concurrent unbonding
      // delegators (a mass-unbond event — exactly when this chart matters)
      // would otherwise be silently truncated. The page cap bounds a
      // misbehaving endpoint; hitting it counts as a fetch failure so the
      // cron's persist gate treats the run as an undercount.
      let pageKey: string | null = null;
      for (let page = 0; page < 10; page++) {
        const p = new URLSearchParams({ "pagination.limit": "1000" });
        if (pageKey) p.set("pagination.key", pageKey);
        const data: UnbondingResponse = await cachedFetch(
          `${LCD_BASE_URL}/cosmos/staking/v1beta1/validators/${v.operatorAddress}/unbonding_delegations?${p.toString()}`,
          false // short cache: unbonding changes continuously
        );
        for (const r of data.unbonding_responses ?? []) {
          for (const e of r.entries ?? []) {
            const day = e.completion_time.slice(0, 10);
            const amt = uosmoToOsmo(e.balance);
            byDay.set(day, (byDay.get(day) ?? 0) + amt);
            total += amt;
            entries.push({
              delegator: r.delegator_address,
              validator: r.validator_address,
              moniker: monikerByOperator.get(r.validator_address) ?? v.moniker,
              amount: amt,
              completionTime: e.completion_time,
            });
          }
        }
        pageKey = data.pagination?.next_key ?? null;
        if (!pageKey) break;
        if (page === 9) {
          // Cap reached with pages remaining: this validator's data is
          // incomplete, so the run's totals are an undercount. Count it as a
          // failure — otherwise the persist gate would bake the truncated
          // figures into the historical series as if they were complete.
          fetchFailures++;
          logger.warn(
            `Unbonding pagination cap hit for ${v.operatorAddress}; marking run incomplete.`
          );
        }
      }
    } catch (error) {
      // A single validator's endpoint failing shouldn't void the whole schedule
      // for LIVE display; log, count the failure (so the cron knows this run is
      // an undercount and refuses to persist it), and continue.
      fetchFailures++;
      logger.warn(
        `Unbonding fetch failed for ${v.operatorAddress}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  const days = [...byDay.entries()]
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Largest entries first, capped so the API payload stays small.
  const topEntries = entries
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_UNBONDING_ENTRIES);
  return { total, days, topEntries, fetchFailures };
}
