// Locks the vote-extraction kernel: which proposal ids count as "this account
// voted" within a page of tx_responses. This parse carries the whole
// governance-participation metric, so its edge cases (batched authz txs with
// several voters, re-votes, malformed events) are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVoterProposalIds, type VoteTxResponse } from "./governance";

const voteEvent = (voter: string, proposalId: string) => ({
  type: "proposal_vote",
  attributes: [
    { key: "voter", value: voter },
    { key: "proposal_id", value: proposalId },
    { key: "option", value: '{"option":1,"weight":"1"}' },
  ],
});

test("plain MsgVote: the voter's proposal id is extracted", () => {
  const txs: VoteTxResponse[] = [{ events: [voteEvent("osmo1aaa", "101")] }];
  assert.deepEqual([...extractVoterProposalIds(txs, "osmo1aaa")], [101]);
});

test("batched authz tx with several voters: only this account's events count", () => {
  // One MsgExec carrying votes for two different granters — the tx matches
  // both accounts' queries, but each must only be credited its own event.
  const txs: VoteTxResponse[] = [
    {
      events: [voteEvent("osmo1aaa", "102"), voteEvent("osmo1bbb", "103")],
    },
  ];
  assert.deepEqual([...extractVoterProposalIds(txs, "osmo1aaa")], [102]);
  assert.deepEqual([...extractVoterProposalIds(txs, "osmo1bbb")], [103]);
});

test("proposal id is read off the matching event, never a sibling's", () => {
  const txs: VoteTxResponse[] = [
    {
      events: [voteEvent("osmo1other", "999"), voteEvent("osmo1aaa", "104")],
    },
  ];
  assert.deepEqual([...extractVoterProposalIds(txs, "osmo1aaa")], [104]);
});

test("re-votes dedupe to one participation per proposal", () => {
  const txs: VoteTxResponse[] = [
    { events: [voteEvent("osmo1aaa", "105")] },
    { events: [voteEvent("osmo1aaa", "105")] }, // changed their vote later
    { events: [voteEvent("osmo1aaa", "106")] },
  ];
  assert.deepEqual(
    [...extractVoterProposalIds(txs, "osmo1aaa")].sort(),
    [105, 106]
  );
});

test("non-vote events and malformed attributes are ignored", () => {
  const txs: VoteTxResponse[] = [
    {
      events: [
        { type: "transfer", attributes: [{ key: "voter", value: "osmo1aaa" }] },
        {
          type: "proposal_vote",
          attributes: [{ key: "voter", value: "osmo1aaa" }],
        }, // no proposal_id
        {
          type: "proposal_vote",
          attributes: [{ key: "proposal_id", value: "107" }],
        }, // no voter
      ],
    },
    {}, // tx with no events at all
  ];
  assert.deepEqual([...extractVoterProposalIds(txs, "osmo1aaa")], []);
});
