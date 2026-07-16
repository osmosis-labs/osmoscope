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
//     (currently stops around prop ~1018) — used ONCE by the backfill script;
//   - a fresh full node (default polkachu) indexes the recent window — the daily
//     cron queries only this, and unions new ids into the ValidatorVote table.
//
// Metric: of the proposals whose voting ENDED in the last 90 days, how many did
// the validator vote on. Age-neutral (fixed proposal set for everyone).
import { LCD_BASE_URL } from "./osmosis-lcd";

// Archive LCD (pruned-history tx index; lags weeks behind the chain tip).
export const ARCHIVE_LCD =
  process.env.ARCHIVE_LCD_BASE_URL || "https://lcd.archive.osmosis.zone";
// Fresh full node whose tx index covers the recent window the archive lacks.
// lcd.osmosis.zone is not used here: it 403s under fan-out load.
export const RECENT_LCD =
  process.env.GOV_RECENT_LCD_BASE_URL || "https://osmosis-api.polkachu.com";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

interface GovProposal {
  id: string;
  voting_end_time: string | null;
  status: string;
}

// Proposals whose voting ENDED within the last 90 days (and has actually ended —
// excludes still-open voting periods, which no one can be marked absent on yet).
// Uses the primary LCD: the proposals endpoint is state, not tx-index, so it is
// complete everywhere.
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
    const resp = await fetch(
      `${LCD_BASE_URL}/cosmos/gov/v1/proposals?${p.toString()}`,
      { headers: { Accept: "application/json" } }
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
interface TxSearchResponse {
  tx_responses?: { events?: TxEvent[] }[];
  total?: string;
  pagination?: { total?: string };
}

// All proposal ids one account has ever voted on, according to ONE source's tx
// index. Pages by `page=` (the tx service's next_key stalls on some nodes, but
// numbered pages advance reliably); per-voter counts are small (tens of txs), so
// the page cap is generous headroom, and hitting it throws rather than silently
// undercounting a voter.
export async function fetchVoterProposalIds(
  account: string,
  baseUrl: string
): Promise<Set<number>> {
  const ids = new Set<number>();
  const query = encodeURIComponent(`proposal_vote.voter='${account}'`);
  for (let page = 1; page <= 10; page++) {
    const resp = await fetch(
      `${baseUrl}/cosmos/tx/v1beta1/txs?query=${query}&limit=100&page=${page}`,
      { headers: { Accept: "application/json" } }
    );
    if (!resp.ok) throw new Error(`voter txs (${baseUrl}): ${resp.status}`);
    const data = (await resp.json()) as TxSearchResponse;
    const txs = data.tx_responses ?? [];
    for (const tr of txs) {
      for (const ev of tr.events ?? []) {
        if (ev.type !== "proposal_vote") continue;
        // A tx can carry several votes (batched authz exec); count only events
        // whose voter IS this account, and read the proposal id off that event.
        const attrs = ev.attributes;
        const voter = attrs.find((a) => a.key === "voter")?.value;
        if (voter !== account) continue;
        const pid = attrs.find((a) => a.key === "proposal_id")?.value;
        if (pid) ids.add(Number(pid));
      }
    }
    const total = Number(data.total ?? data.pagination?.total ?? 0);
    if (page * 100 >= total || txs.length === 0) return ids;
  }
  throw new Error(`voter ${account}: >1000 vote txs, refusing to truncate`);
}
