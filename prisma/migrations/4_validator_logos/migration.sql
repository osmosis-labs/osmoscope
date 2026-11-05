-- CreateTable
CREATE TABLE IF NOT EXISTS "validator_logos" (
    "operatorAddress" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "contentType" TEXT,
    "data" BYTEA,
    "fetchedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "validator_logos_pkey" PRIMARY KEY ("operatorAddress")
);
