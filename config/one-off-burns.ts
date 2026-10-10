// Curated list of one-off OSMO burns: large, governance-directed sends of existing
// OSMO to the null address (community pool and subDAO treasury burns), as opposed
// to the protocol's recurring burn (taker-fee and protorev OSMO burned each epoch).
//
// Burn is measured as the null-address balance, so every send there lands in
// burnedSupply. That is right for the cumulative figures (total burned, % burned,
// total supply), which include these burns. It is wrong for the RATE figures: a
// single 16M OSMO day annualizes to thousands of percent and would swamp the
// daily net inflation, the 30-day burn rate and the 90-day net inflation KPI for
// months. Rate calculations therefore subtract the burns listed here (see
// lib/one-off-burns.ts), and the snapshot sanity gate accepts a supply drop that
// a listed burn explains.
//
// Add an entry as soon as a burn executes (ideally before the next daily
// snapshot: an unlisted burn over the snapshot gate's 5M OSMO tolerance blocks
// that day's snapshot until it is listed). A late entry still corrects history,
// because every rate is recomputed from the stored cumulative series.
//
// `time` is the block time of the burn, read from the chain. `amount` is the exact
// uosmo sent to the null address, expressed in OSMO (6 decimals). Only list OSMO;
// other denoms burned alongside do not affect these figures.

export interface OneOffBurn {
  /** Block time of the burn, ISO 8601 UTC. */
  time: string;
  /** Block height of the burn. */
  height: number;
  /** OSMO sent to the null address (uosmo / 1e6, exact). */
  amount: number;
  /** Short description shown next to the burn in the UI. */
  label: string;
  txHash?: string;
}

// Ordered oldest → newest.
export const ONE_OFF_BURNS: OneOffBurn[] = [
  {
    time: "2026-10-10T01:59:52Z",
    height: 72237968,
    amount: 16_091_897.24478,
    label:
      "Liquidity SubDAO burn of OSMO recovered from community pool liquidity (Props 1049 and 1050)",
    txHash: "156867B6E560E7E3A829F498D43A03C25434E45B8E70E247E1B4500E8D058488",
  },
];
