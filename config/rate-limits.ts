// Onchain addresses and endpoint fallbacks for the IBC rate-limit monitor,
// centralised alongside the other curated onchain identifiers (see
// config/community-pool.ts for the precedent).

// The in-chain x/ibc-rate-limit middleware's governing CosmWasm contract.
export const RATE_LIMITER_CONTRACT =
  "osmo17r7qdw2zk6jyw62cvwm6flmhtj9q7zd26r8zc6sqyf0pnaq46cfss8hgxg";

// Public LCD fallbacks for the raw contract-state dump (tried after the
// primary LCD_BASE_URL). The dump is a handful of plain REST pages, not
// CosmWasm smart queries, so public endpoints hold up fine when the primary
// throttles.
export const RATE_LIMIT_LCD_FALLBACKS = [
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
];
