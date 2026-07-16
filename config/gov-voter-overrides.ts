// Operator → governance-voter account overrides for validators whose votes do
// NOT come from their operator-derived account (bech32-reprefixed
// osmovaloper1… → osmo1…). Verified 2026-07: all 65 voting validators among
// the 70 bonded vote from the derived account (the other 5 have never voted on
// either tx index, matching their zero SmartStake scores), so this map is
// EMPTY today. It stays as the mechanism for the day a validator genuinely
// votes from elsewhere; there is no onchain link between an operator and an
// unrelated voting account, so each future entry must document how it was
// established.
//
// Verification lesson (why an entry once existed here): checking a candidate
// against ONE tx index is not enough. bitszn was wrongly mapped to null
// because the archive LCD showed zero votes for its derived account — but its
// entire voting history postdates the archive's stale index tip, and the
// recent-index node showed all of it. Always probe BOTH sources before
// concluding a validator votes from an unknown account.
//
// Value semantics:
//   - an osmo1… address: the validator's actual voting account (score from it)
//   - null: the voting account is KNOWN to differ but hasn't been identified;
//     display null rather than a wrong 0 from the derived account.
//
// Filling in or removing an entry needs no manual backfill: an account with
// zero accumulated ValidatorVote rows is first-seeded from BOTH tx-index
// sources by the next daily cron automatically.
export const GOV_VOTER_OVERRIDES: Record<string, string | null> = {};
