// Confirm-on-repeat rule for the treasury's proportional-move gate.
//
// buildTreasurySnapshot refuses a snapshot whose main pool moved more than 15%
// against the last stored one (MainPoolMoveError), because a swing that large is
// usually a partial fetch. But a genuine large move (a big community-pool spend)
// also trips it, and since the comparison baseline is the last SAVED snapshot,
// the gate would then refuse every later run too and freeze the page for good.
//
// The way out: hold each out-of-range reading as a candidate and accept the new
// level once the most recent MOVE_CONFIRMATIONS consecutive readings agree with
// each other within MOVE_CONFIRM_TOLERANCE. A real move reproduces the same
// value hour after hour; a partial fetch drops a different subset each time (or
// recovers), so it doesn't. Pure so the rule can be unit-tested; the cron owns
// the persistence (lib/treasury/store.ts).

// Consecutive agreeing out-of-range readings required before the new level is
// accepted. With the hourly cron that's the third run, so a genuine move shows
// up about two hours late.
export const MOVE_CONFIRMATIONS = 3;

// How closely those readings must agree: (max - min) / max. Hour-to-hour market
// drift on a pool of mostly stablecoins and majors is well inside 1%, while a
// partial fetch that happens to miss a different position each time is not.
export const MOVE_CONFIRM_TOLERANCE = 0.01;

// `readings` are the main-pool values of the held candidates, oldest first,
// INCLUDING the current one. True once the newest MOVE_CONFIRMATIONS of them
// agree within MOVE_CONFIRM_TOLERANCE.
export function isMoveConfirmed(
  readings: number[],
  confirmations: number = MOVE_CONFIRMATIONS,
  tolerance: number = MOVE_CONFIRM_TOLERANCE
): boolean {
  if (readings.length < confirmations) return false;
  const recent = readings.slice(-confirmations);
  if (!recent.every((v) => Number.isFinite(v) && v > 0)) return false;
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  return (max - min) / max <= tolerance;
}
