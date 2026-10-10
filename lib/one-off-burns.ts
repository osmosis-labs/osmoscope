// Recurring-burn view of the cumulative burn series, for rate calculations.
//
// burnedSupply on each snapshot is the cumulative null-address balance and
// includes one-off governance burns (config/one-off-burns.ts). Anything that
// turns burn into a RATE (daily burn rate, net inflation, the daily burn bars)
// must use recurringBurned() instead, so a one-off burn never reads as a day of
// protocol burn. Cumulative displays (total burned, % burned, total supply) keep
// using burnedSupply.
//
// Subtracting by timestamp, rather than skipping the day of the burn, keeps the
// recurring burn measured that day and stays correct when snapshot days are
// missing: the one-off amount drops out of whichever delta spans its block time.

import { ONE_OFF_BURNS, type OneOffBurn } from "@/config/one-off-burns";

type Ts = string | number | Date;

const ms = (t: Ts): number => new Date(t).getTime();

/** Total one-off OSMO burned at or before `at`. */
export function oneOffBurnedBy(
  at: Ts,
  burns: OneOffBurn[] = ONE_OFF_BURNS
): number {
  const t = ms(at);
  let sum = 0;
  for (const b of burns) if (ms(b.time) <= t) sum += b.amount;
  return sum;
}

/** One-off burns with a block time in (from, to]. */
export function oneOffBurnsBetween(
  from: Ts,
  to: Ts,
  burns: OneOffBurn[] = ONE_OFF_BURNS
): OneOffBurn[] {
  const f = ms(from);
  const t = ms(to);
  return burns.filter((b) => ms(b.time) > f && ms(b.time) <= t);
}

/**
 * Cumulative burn excluding one-off burns, for rate calculations. Tolerates the
 * older `burned` field name. A missing value stays 0, as the callers treated it
 * before, rather than going negative by the one-off total.
 */
export function recurringBurned(
  r: {
    timestamp: string;
    burnedSupply?: number | null;
    burned?: number | null;
  },
  burns: OneOffBurn[] = ONE_OFF_BURNS
): number {
  const cumulative = r.burnedSupply || r.burned || 0;
  return cumulative ? cumulative - oneOffBurnedBy(r.timestamp, burns) : 0;
}
