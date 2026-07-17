// Endpoint policy for every LCD consumer in the dashboard: prefer our own
// endpoints (lcd.osmosis.zone and the archive), and reach for third-party
// nodes only as failover or where our own coverage genuinely falls short.
// Verified capabilities (2026-07):
//   - lcd.osmosis.zone serves plain REST, cosmwasm state pages, AND tx-index
//     event queries — but its tx-index retention is SHALLOW (roughly the last
//     two weeks; props 1022+ visible while polkachu reaches 1019+).
//   - lcd.archive.osmosis.zone retains pruned history but its tx index lags
//     weeks behind the tip (~prop 1018 era).
//   - polkachu's tx index is the deepest "recent" source and bridges the gap
//     between the archive tip and lcd.osmosis.zone's shallow floor.

// Primary LCD for everything (env-overridable, e.g. local dev).
export const LCD_PRIMARY =
  process.env.NEXT_PUBLIC_LCD_BASE_URL || "https://lcd.osmosis.zone";

// Archive LCD: pruned-history queries (deep tx index, stale tip).
export const ARCHIVE_LCD =
  process.env.ARCHIVE_LCD_BASE_URL || "https://lcd.archive.osmosis.zone";

// Deep third-party tx index (see coverage note above).
export const DEEP_TX_INDEX_LCD =
  process.env.GOV_RECENT_LCD_BASE_URL || "https://osmosis-api.polkachu.com";

// Recent tx-index queries that only need days of depth (the daily vote
// accumulate): own node first, deep third-party only as failover. In steady
// state the fallback is never hit.
export const TX_INDEX_ENDPOINTS = [LCD_PRIMARY, DEEP_TX_INDEX_LCD];

// First-seed / backfill vote queries need FULL depth with no seam: the archive
// covers old history, the deep index bridges to the shallow primary's floor,
// and the primary covers the newest txs. Results are UNIONED across all three
// (not failover — the primary alone would silently miss the archive-to-primary
// gap, currently props 1019-1021).
export const TX_INDEX_SEED_SOURCES = [
  ARCHIVE_LCD,
  DEEP_TX_INDEX_LCD,
  LCD_PRIMARY,
];

// Plain-REST failover chain for heavy fan-outs (the daily ~71-call unbonding
// enumeration): own node first, public fallbacks after — the same pattern the
// rate-limit contract dump uses (config/rate-limits.ts).
export const REST_FALLBACK_ENDPOINTS = [
  LCD_PRIMARY,
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
];
