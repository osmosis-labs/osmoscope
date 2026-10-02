-- AlterTable
ALTER TABLE "rate_limit_readings"
    ADD COLUMN IF NOT EXISTS "sendPct" INTEGER,
    ADD COLUMN IF NOT EXISTS "recvPct" INTEGER,
    ADD COLUMN IF NOT EXISTS "periodEnd" BIGINT;

-- Backfill from the snapshot written with each reading (same timestamp).
UPDATE "rate_limit_readings" r
SET "sendPct" = (w->>'sendPct')::integer,
    "recvPct" = (w->>'recvPct')::integer,
    "periodEnd" = (w->>'periodEnd')::bigint
FROM "rate_limit_snapshots" s,
    jsonb_array_elements(s."data"->'paths') p,
    jsonb_array_elements(p->'windows') w
WHERE s."timestamp" = r."timestamp"
    AND p->>'channel' = r."channel"
    AND p->>'denom' = r."denom"
    AND w->>'quotaName' = r."quotaName"
    AND r."sendPct" IS NULL;
