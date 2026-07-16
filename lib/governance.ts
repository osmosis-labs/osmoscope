// Validator governance participation, computed from the chain directly (no
// indexer, no third-party import).
//
// Votes are found BY VOTER, not by proposal: `proposal_vote.voter='osmo1…'`
// tx-event queries return one account's handful of vote txs, so pagination never
// truncates — unlike by-proposal enumeration, which caps at ~100 votes per
// proposal and silently misses the rest (the flaw that originally made this
// metric look unbuildable). The proposal_vote EVENT carries the real voter
// through authz/REStake wrappers, so wrapped votes are found too; proposal ids
// are then read from the events whose voter attribute matches the account.
//
// Endpoint policy (config/lcd-endpoints.ts): our own nodes first, third-party
// only as failover or where our coverage genuinely falls short. Three tx-index
// sources with different depth (all verified 2026-07):
//   - the ARCHIVE LCD retains pruned history but its index lags weeks behind
//     the tip (~prop 1018 era);
//   - lcd.osmosis.zone's index works but is SHALLOW (roughly two weeks;
//     props 1022+) — plenty for the daily incremental accumulate, never
//     enough for a first seed;
//   - the deep third-party index (polkachu) bridges the archive-to-primary
//     gap (props 1019+).
// Daily accumulates use own-first FAILOVER (third party only when the primary
// errors); first seeds UNION the sources, and the archive + deep source must
// both succeed or the seed throws — a failover there would silently miss the
// bridge range.
//
// Metric: of the proposals whose voting ENDED in the last 90 days, how many did
// the validator vote on. Age-neutral (fixed proposal set for everyone).
import { LCD_BASE_URL, fetchWithRetry } from "./osmosis-lcd";
import { logger } from "./logger";
import {
  ARCHIVE_LCD,
  DEEP_TX_INDEX_LCD,
  LCD_PRIMARY,
  TX_INDEX_ENDPOINTS,
} from "@/config/lcd-endpoints";

export { ARCHIVE_LCD };

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Per-attempt timeout on every LCD call in this module: these run inside the
// daily snapshot cron, where one hung socket would otherwise hold a fan-out
// slot until the platform kills the whole function.
const FETCH_TIMEOUT_MS = 10_000;

interface GovProposal {
  id: string;
  voting_end_time: string | null;
}

// Proposals whose voting ENDED within the last 90 days (and has actually ended —
// excludes still-open voting periods, which no one can be marked absent on yet).
// Uses the primary LCD: the proposals endpoint is state, not tx-index, so it is
// complete everywhere. Returning an empty window (no proposals decided in 90
// days — implausible on Osmosis) makes the caller skip scoring entirely rather
// than write zeros.
export async function fetchRecentlyEndedProposals(
  now: number
): Promise<number[]> {
  const cutoff = now - NINETY_DAYS_MS;
  const out: number[] = [];
  // Newest-first; stop paging once a whole page is older than the cutoff.
  let key: string | null = null;
  for (let page = 0; page < 10; page++) {
    const p = new URLSearchParams({
      "pagination.limit": "100",
      "pagination.reverse": "true",
    });
    if (key) p.set("pagination.key", key);
    const resp = await fetchWithRetry(
      `${LCD_BASE_URL}/cosmos/gov/v1/proposals?${p.toString()}`,
      3,
      1000,
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) throw new Error(`proposals: ${resp.status}`);
    const data = (await resp.json()) as {
      proposals: GovProposal[];
      pagination: { next_key: string | null };
    };
    let allOlder = data.proposals.length > 0;
    for (const pr of data.proposals) {
      if (!pr.voting_end_time) continue;
      const end = new Date(pr.voting_end_time).getTime();
      if (end > now) continue; // still open — not decided yet
      if (end >= cutoff) {
        out.push(Number(pr.id));
        allOlder = false;
      }
    }
    if (allOlder) break;
    key = data.pagination?.next_key ?? null;
    if (!key) break;
  }
  return out;
}

interface TxEvent {
  type: string;
  attributes: { key: string; value: string }[];
}
export interface VoteTxResponse {
  events?: TxEvent[];
}
interface TxSearchResponse {
  tx_responses?: VoteTxResponse[];
  total?: string;
  pagination?: { total?: string };
}

// The proposal ids one account voted on within a page of tx_responses. Pure —
// this parse IS the metric's extraction kernel, so it's exported and unit
// tested (lib/governance.test.ts). A tx can carry several proposal_vote events
// (a batched authz exec voting for multiple grantees); only events whose voter
// attribute IS this account count, and the proposal id is read off that same
// event, never a sibling's.
export function extractVoterProposalIds(
  txResponses: VoteTxResponse[],
  account: string
): Set<number> {
  const ids = new Set<number>();
  for (const tr of txResponses) {
    for (const ev of tr.events ?? []) {
      if (ev.type !== "proposal_vote") continue;
      const attrs = ev.attributes;
      const voter = attrs.find((a) => a.key === "voter")?.value;
      if (voter !== account) continue;
      const pid = attrs.find((a) => a.key === "proposal_id")?.value;
      if (pid) ids.add(Number(pid));
    }
  }
  return ids;
}

// All proposal ids one account has ever voted on, according to ONE source's tx
// index. Pages by `page=` (the tx service's next_key stalls on some nodes, but
// numbered pages advance reliably); per-voter counts are small (tens of txs),
// so the page cap is generous headroom, and hitting it throws rather than
// silently undercounting a voter.
export async function fetchVoterProposalIds(
  account: string,
  baseUrl: string
): Promise<Set<number>> {
  const ids = new Set<number>();
  const query = encodeURIComponent(`proposal_vote.voter='${account}'`);
  for (let page = 1; page <= 10; page++) {
    const resp = await fetchWithRetry(
      `${baseUrl}/cosmos/tx/v1beta1/txs?query=${query}&limit=100&page=${page}`,
      3,
      1000,
      FETCH_TIMEOUT_MS
    );
    if (!resp.ok) throw new Error(`voter txs (${baseUrl}): ${resp.status}`);
    const data = (await resp.json()) as TxSearchResponse;
    const txs = data.tx_responses ?? [];
    for (const id of extractVoterProposalIds(txs, account)) ids.add(id);
    // Stop on the response's total when present. Some node configs omit it —
    // treating an absent total as 0 would end paging after page 1 even with a
    // full page in hand (a silent undercount, the exact failure this by-voter
    // design exists to prevent) — so with no usable total, keep paging while
    // pages come back full; the page cap still bounds the loop.
    const totalRaw = data.total ?? data.pagination?.total;
    const total = totalRaw == null ? null : Number(totalRaw);
    if (total != null && total > 0) {
      if (page * 100 >= total) return ids;
    } else if (txs.length < 100) {
      return ids;
    }
  }
  throw new Error(`voter ${account}: >1000 vote txs, refusing to truncate`);
}

// Recent votes for an already-seeded voter: only days of depth needed, so this
// is own-node first with the deep third-party index as FAILOVER — in steady
// state the fallback never fires. Throws only when every endpoint fails.
export async function fetchVoterProposalIdsRecent(
  account: string
): Promise<Set<number>> {
  let lastError: unknown = null;
  for (const endpoint of TX_INDEX_ENDPOINTS) {
    try {
      return await fetchVoterProposalIds(account, endpoint);
    } catch (e) {
      lastError = e;
      logger.warn(
        `Recent vote fetch failed on ${endpoint} for ${account}; trying next: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  throw lastError ?? new Error("no tx-index endpoints configured");
}

// FULL-depth votes for a first seed (new validator, override change, or the
// backfill script): union across all three index sources. The archive (old
// history) and the deep index (the archive-to-primary bridge, currently props
// 1019-1021) are REQUIRED — failing either would silently under-seed, which is
// worse than deferring the seed to the next run — while the shallow primary is
// redundancy on the newest slice and may fail with only a warning.
export async function fetchVoterProposalIdsFullDepth(
  account: string
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const source of [ARCHIVE_LCD, DEEP_TX_INDEX_LCD]) {
    for (const id of await fetchVoterProposalIds(account, source)) {
      ids.add(id);
    }
  }
  try {
    for (const id of await fetchVoterProposalIds(account, LCD_PRIMARY)) {
      ids.add(id);
    }
  } catch (e) {
    logger.warn(
      `Primary tx-index skipped in full-depth fetch for ${account}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return ids;
}
