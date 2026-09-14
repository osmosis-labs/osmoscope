-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "historical_records" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "dayEpoch" INTEGER,
    "burnedSupply" DECIMAL(20,6) NOT NULL,
    "mintedSupply" DECIMAL(20,6) NOT NULL,
    "totalSupply" DECIMAL(20,6) NOT NULL,
    "circulatingSupply" DECIMAL(20,6),
    "restrictedSupply" DECIMAL(20,6),
    "communitySupply" DECIMAL(20,6),
    "devVestingSupply" DECIMAL(20,6),
    "inflationRate" DECIMAL(10,6) NOT NULL,
    "totalStaked" DECIMAL(20,6),
    "stakingApr" DECIMAL(10,6),
    "stakingRate" DECIMAL(10,6),
    "nakamotoCoefficient" INTEGER,
    "giniCoefficient" DECIMAL(10,6),
    "pendingUndelegations" DECIMAL(20,6),
    "blockRate" DECIMAL(10,4),
    "blockHeight" BIGINT,
    "supplyOffsetNormalized" BOOLEAN,
    "genesisBackfilled" BOOLEAN,
    "inflationRecomputed" BOOLEAN,
    "restrictedStakedPending" BOOLEAN,
    "distributionProportions" JSONB,
    "osmoTakerFeeDistribution" JSONB,
    "nonOsmoTakerFeeDistribution" JSONB,
    "communityPoolDenomWhitelist" TEXT[],
    "communityPoolDenomToSwapNonWhitelistedAssetsTo" TEXT,
    "txnFeesRevenue" DECIMAL(20,2),
    "takerFeesRevenue" DECIMAL(20,2),
    "protorevRevenue" DECIMAL(20,2),
    "mevRevenue" DECIMAL(20,2),
    "totalRevenue" DECIMAL(20,2),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "historical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "totalValue" DECIMAL(20,2) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validator_snapshots" (
    "operatorAddress" TEXT NOT NULL,
    "govVotesLast10" INTEGER,
    "govVotedRecent" INTEGER,
    "govRecentWindow" INTEGER,
    "timesSlashed" INTEGER,
    "latestSlashedTime" TIMESTAMPTZ(6),
    "longRunUptime" DECIMAL(7,4),
    "selfBondPercentage" DECIMAL(9,4),
    "cronSlashCount" INTEGER,
    "cronLastSlashTime" TIMESTAMPTZ(6),
    "prevJailedUntil" TIMESTAMPTZ(6),
    "prevTombstoned" BOOLEAN,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "validator_snapshots_pkey" PRIMARY KEY ("operatorAddress")
);

-- CreateTable
CREATE TABLE "validator_daily" (
    "operatorAddress" TEXT NOT NULL,
    "date" TIMESTAMPTZ(6) NOT NULL,
    "uptime" DECIMAL(7,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validator_daily_pkey" PRIMARY KEY ("operatorAddress","date")
);

-- CreateTable
CREATE TABLE "undelegation_days" (
    "date" TIMESTAMPTZ(6) NOT NULL,
    "amountCompleting" DECIMAL(20,6) NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "undelegation_days_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "unbonding_forecast" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "computedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "unbonding_forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validator_votes" (
    "operatorAddress" TEXT NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validator_votes_pkey" PRIMARY KEY ("operatorAddress","proposalId")
);

-- CreateTable
CREATE TABLE "rate_limit_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "pathCount" INTEGER NOT NULL,
    "maxUtilizationPct" DECIMAL(8,2) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_alert_states" (
    "pathKey" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "pct" DECIMAL(8,2) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_alert_states_pkey" PRIMARY KEY ("pathKey")
);

-- CreateTable
CREATE TABLE "rate_limit_readings" (
    "timestamp" TIMESTAMPTZ(6) NOT NULL,
    "channel" TEXT NOT NULL,
    "denom" TEXT NOT NULL,
    "quotaName" TEXT NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "channelValue" DECIMAL(78,0),
    "inflow" DECIMAL(78,0) NOT NULL,
    "outflow" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "rate_limit_readings_pkey" PRIMARY KEY ("timestamp","channel","denom","quotaName")
);

-- CreateIndex
CREATE UNIQUE INDEX "historical_records_timestamp_key" ON "historical_records"("timestamp");

-- CreateIndex
CREATE INDEX "historical_records_timestamp_idx" ON "historical_records"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "historical_records_createdAt_idx" ON "historical_records"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_snapshots_timestamp_key" ON "treasury_snapshots"("timestamp");

-- CreateIndex
CREATE INDEX "treasury_snapshots_timestamp_idx" ON "treasury_snapshots"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "validator_daily_operatorAddress_date_idx" ON "validator_daily"("operatorAddress", "date" DESC);

-- CreateIndex
CREATE INDEX "undelegation_days_date_idx" ON "undelegation_days"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_snapshots_timestamp_key" ON "rate_limit_snapshots"("timestamp");

-- CreateIndex
CREATE INDEX "rate_limit_readings_denom_timestamp_idx" ON "rate_limit_readings"("denom", "timestamp" ASC);
