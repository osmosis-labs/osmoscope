import type { NumiaAprEntry } from "@/types/osmosis";

// Pure helpers for Numia's /apr series. Shared by the daily snapshot, the
// hourly refresh and the one-off resync script so all three key rows the same
// way: a HistoricalRecord dated D (UTC) carries Numia's APR FOR D, and its
// stakingRate is the average over D-30..D (both ends inclusive, matching the
// start_date/end_date range the snapshot has always requested).
//
// Numia returns entries newest-first and only publishes D the following day,
// so array position must never be used to pick "today": doing so picked the
// oldest day of the window and stored a value 30 days stale on every row.

export const APR_WINDOW_DAYS = 30;

// Fewest days of data a trailing average needs before it is written. A partial
// Numia response (an outage returning only part of the range) would otherwise
// bake a skewed average into the row; leaving it unset lets a later refresh
// fill it once the data is back. A normal snapshot-time window has 30 of 31.
export const MIN_APR_WINDOW_ENTRIES = 25;

// YYYY-MM-DD (UTC) offset by a number of days.
export function shiftDate(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

// Days where Numia's published APR is known to be wrong, replaced with an
// onchain figure. Applied inside aprByDate so the snapshot, the hourly refresh
// and the resync script all use the corrected value; otherwise the hourly
// refresh would rewrite Numia's figure over a hand-edited row.
//
// Onchain method: uosmo delegation-reward accrual between consecutive day-epoch
// payouts (archive LCD, ~30 delegations across the four largest validators,
// all agreeing to 3dp), grossed up by each validator's commission, annualised
// x365, then netted by the active set's stake-weighted commission. Numia's day
// D is the payout at the epoch on D. The same method lands within ~1-2% of
// Numia on 2026-10-17..20 and within ~4% on the clean days before.
export const NUMIA_APR_OVERRIDES: Record<string, number> = {
  // Numia published 4.04 / 4.10 / 4.16, about half the onchain rate, across
  // the drop in bonded stake and the rise in stakers' taker-fee share.
  "2026-10-14": 6.884,
  "2026-10-15": 9.311,
  "2026-10-16": 7.754,
};

// One APR per UTC date. Numia lists each day under both "OSMO" and "total"
// (same value); OSMO wins when both are present. Dates in NUMIA_APR_OVERRIDES
// that Numia covers take the override instead.
export function aprByDate(entries: NumiaAprEntry[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const e of entries) {
    if (e.symbol !== "OSMO" && e.symbol !== "total") continue;
    if (!Number.isFinite(e.apr)) continue;
    const date = e.labels.split(" ")[0];
    if (e.symbol === "OSMO" || !byDate.has(date)) byDate.set(date, e.apr);
  }
  for (const [date, apr] of Object.entries(NUMIA_APR_OVERRIDES)) {
    if (byDate.has(date)) byDate.set(date, apr);
  }
  return byDate;
}

// Average APR over D-30..D, or undefined when too few days are present.
export function trailingAprAverage(
  byDate: Map<string, number>,
  day: string
): number | undefined {
  const vals: number[] = [];
  for (let i = 0; i <= APR_WINDOW_DAYS; i++) {
    const v = byDate.get(shiftDate(day, -i));
    if (v != null) vals.push(v);
  }
  if (vals.length < MIN_APR_WINDOW_ENTRIES) return undefined;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
