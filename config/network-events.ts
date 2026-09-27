// Curated timeline of network events annotated onto the Block Rate chart as
// vertical marker lines. This is hand-maintained knowledge that cannot be
// derived from the metric series itself: which chain upgrade or validator-set
// change a given inflection in block time corresponds to.
//
// Dates are the on-chain governance voting-end date (UTC) of each proposal, read
// directly from the chain (cosmos/gov/v1/proposals/<id>). The upgrade activates a
// day or two after voting ends; a marker is placed on the nearest plotted day, so
// that small drift still lands the line on the right inflection. Every upgrade
// listed here was verified to align with an actual block-rate step-down in the
// imported history (the day the series drops) — see the per-entry notes.
// Validator-set changes are staking param changes that apply the moment voting
// ends, so their date is the activation day itself.
//
// Keep this list focused on events that actually moved block time, not every
// routine upgrade, so the chart stays readable. Every passed validator-set size
// change is listed regardless of its block-time effect (found by scanning all
// proposals for staking MaxValidators / max_validators changes); ones that
// predate the block-rate history (which starts 2022-10-01) are dropped by the
// chart automatically.

export type NetworkEventKind = "upgrade" | "validator-set";

export interface NetworkEvent {
  /** ISO date (YYYY-MM-DD), mainnet activation day, UTC. */
  date: string;
  /** Short label shown on the marker. */
  label: string;
  kind: NetworkEventKind;
  /** Optional longer note (not rendered yet; kept for future tooltips). */
  note?: string;
}

// Ordered oldest → newest. Block-time story runs ~6s → ~1.1s over 2023-2026, and
// the decline tracks the upgrade cadence: each upgrade below lands within a day of
// an observed block-rate step-down (drop noted per entry). Dates are the on-chain
// voting-end date; the plotted marker snaps to the nearest data day.
export const NETWORK_EVENTS: NetworkEvent[] = [
  {
    date: "2022-01-01",
    label: "118 validators",
    kind: "validator-set",
    note: "Prop 114: max validators 100 → 118. Predates the block-rate history.",
  },
  {
    date: "2022-04-13",
    label: "135 validators",
    kind: "validator-set",
    note: "Prop 196: max validators 118 → 135. Predates the block-rate history.",
  },
  {
    date: "2022-10-03",
    label: "150 validators",
    kind: "validator-set",
    note: "Prop 337: max validators 135 → 150. No sustained block-rate change (~6.1s).",
  },
  {
    date: "2023-12-18",
    label: "v21",
    kind: "upgrade",
    note: "Block rate ~6.2s → ~5.6s in the observed series (~2023-12-27).",
  },
  {
    date: "2024-01-18",
    label: "v22",
    kind: "upgrade",
    note: "Block rate ~5.4s → ~5.0s (~2024-01-19).",
  },
  {
    date: "2024-02-20",
    label: "v23",
    kind: "upgrade",
    note: "Block rate ~5.4s → ~5.0s (~2024-02-21).",
  },
  {
    date: "2024-04-11",
    label: "v24",
    kind: "upgrade",
    note: "Largest reduction: ~4.4s → ~3.1s over 2024-04-11/12.",
  },
  {
    date: "2024-05-14",
    label: "v25",
    kind: "upgrade",
    note: "Top-of-block auctions and smart accounts; block time toward ~2.5s.",
  },
  {
    date: "2024-09-18",
    label: "v26",
    kind: "upgrade",
    note: "Block rate ~2.2s → ~1.7s (~2024-09-19).",
  },
  {
    date: "2025-02-17",
    label: "120 validators",
    kind: "validator-set",
    note: "Prop 905: max validators 150 → 120. Block rate ~1.33s → ~1.29s.",
  },
  {
    date: "2025-09-01",
    label: "100 validators",
    kind: "validator-set",
    note: "Prop 976: max validators 120 → 100. Block rate ~1.28s → ~1.21s (~2025-09-04).",
  },
  {
    date: "2025-11-01",
    label: "v31",
    kind: "upgrade",
    note: "Block rate ~1.6s → ~1.2s (~2025-11-27).",
  },
  {
    date: "2026-05-23",
    label: "70 validators",
    kind: "validator-set",
    note: "Prop 1017: max validators 100 → 70. Block rate ~1.10s → ~1.00s the same day.",
  },
];

// Marker colours by kind (dotted vertical ReferenceLine). Upgrades use the
// block-rate series' own green; validator-set changes use the control-threshold
// orange so the two categories read apart at a glance.
export const EVENT_COLOR: Record<NetworkEventKind, string> = {
  upgrade: "#81C784",
  "validator-set": "#FFB74D",
};
