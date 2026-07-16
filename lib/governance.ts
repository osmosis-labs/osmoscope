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
// Two sources with different index coverage:
//   - the ARCHIVE LCD retains pruned history but its tx index lags weeks behind
//     (currently stops around prop ~1018) — read by the backfill script and by
//     the cron's first-seed path for newly appeared voters;
//   - a fresh full node (default polkachu) indexes the recent window — its
//     index FLOOR is ~60 days back, INSIDE the 90-day scoring window, which is
//     why an already-seeded validator can accumulate from it alone but a
//     never-seeded one cannot.
// INVARIANT the two-source union depends on: archive index tip >= recent index
// floor (verified 2026-07: archive reaches ~prop 1018, polkachu back to ~1016).
// If the archive ever lags past the recent floor, a coverage gap opens between
// them for first-seeds.
//
// Metric: of the proposals whose voting ENDED in the last 90 days, how many did
// the validator vote on. Age-neutral (fixed proposal set for everyone).
import { LCD_BASE_URL, fetchWithRetry } from "./osmosis-lcd";

// Archive LCD (pruned-history tx index; lags weeks behind the chain tip).
export const ARCHIVE_LCD =
  process.env.ARCHIVE_LCD_BASE_URL || "https://lcd.archive.osmosis.zone";
// Fresh full node whose tx index covers the recent window the archive lacks.
// lcd.osmosis.zone is not used here: it 403s under fan-out load.
export const RECENT_LCD =
  process.env.GOV_RECENT_LCD_BASE_URL || "https://osmosis-api.polkachu.com";

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
