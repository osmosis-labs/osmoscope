-- AlterTable
-- No backfill: readings taken before the contract's 0.2.0 migration have no
-- absolute bound, and NULL (not zero) is how that is recorded.
ALTER TABLE "rate_limit_readings"
    ADD COLUMN IF NOT EXISTS "maxAbsoluteSend" DECIMAL(78,0),
    ADD COLUMN IF NOT EXISTS "maxAbsoluteRecv" DECIMAL(78,0);

-- From 0.2.0 a percentage is an unclamped u32, which can exceed INTEGER.
ALTER TABLE "rate_limit_readings"
    ALTER COLUMN "sendPct" SET DATA TYPE BIGINT,
    ALTER COLUMN "recvPct" SET DATA TYPE BIGINT;
