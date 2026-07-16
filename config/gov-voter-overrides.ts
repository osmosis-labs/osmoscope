// Operator → governance-voter account overrides for the few validators whose
// votes do NOT come from their operator-derived account (bech32-reprefixed
// osmovaloper1… → osmo1…). Verified 2026-07: 64 of 70 bonded validators vote
// from the derived account and 5 genuinely never vote, so this list should stay
// very short. Hand-maintained knowledge: there is no onchain link between an
// operator and an unrelated voting account, so each entry documents how it was
// established.
//
// Value semantics:
//   - an osmo1… address: the validator's actual voting account (score from it)
//   - null: the voting account is KNOWN to differ but hasn't been identified;
//     display null rather than a wrong 0 from the derived account.
export const GOV_VOTER_OVERRIDES: Record<string, string | null> = {
  // bitszn | valopers.com — SmartStake shows recent participation (7/10) but the
  // operator-derived account has zero onchain votes, so it votes from an
  // unidentified account. Null until that account is found.
  osmovaloper18kxyn3dpmwnmctzkgckfcgp7a4nzss0lq2qpk9: null,
};
