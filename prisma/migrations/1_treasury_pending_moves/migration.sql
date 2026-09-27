-- CreateTable
CREATE TABLE IF NOT EXISTS "treasury_pending_moves" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "mainPoolValue" DECIMAL(20,2) NOT NULL,
    "baselineValue" DECIMAL(20,2) NOT NULL,

    CONSTRAINT "treasury_pending_moves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "treasury_pending_moves_timestamp_idx" ON "treasury_pending_moves"("timestamp");
