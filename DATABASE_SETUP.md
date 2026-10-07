# Database Setup Guide

This guide explains how OSMOscope's historical data is stored and how to set up a database for it.

## Overview

OSMOscope stores its historical OSMO tokenomics data in **Postgres** (Prisma Postgres in production) through **Prisma ORM** (Prisma 7 with the `@prisma/adapter-pg` driver adapter). This provides:

- ✅ Efficient querying with indexes
- ✅ Pagination and filtering support
- ✅ ACID guarantees (no more race conditions)
- ✅ Type-safe database access
- ✅ Scalability for growing datasets

## Prerequisites

- Node.js 22 (see `.nvmrc`) and Yarn 4 (enable it with `corepack enable`)
- Either Docker (for a local database, `docker-compose.yml`) or the production
  connection string from the Prisma console

## Setup Steps

### 1. Choose a Database

- **Local:** `docker compose up -d` starts Postgres with the credentials in
  `.env.local.example`.
- **Production:** the Prisma Postgres database. Use its direct connection
  string (`postgres://…@db.prisma.io:5432/…`). Scripts run against it write to
  production data, and the Prisma account's operation limit is shared with the
  alloy dashboard, so keep one-off scripts small.

### 2. Configure the Connection

Copy `.env.local.example` to `.env.local` and set:

- `DATABASE_URL`: read by the Prisma CLI (`prisma.config.ts`), the crons and the scripts
- `POSTGRES_PRISMA_URL`: read first by the app runtime (`lib/database.ts`); set it to the same value

In production the same URL is stored in three places:

- the Worker secret `POSTGRES_PRISMA_URL` (`npx wrangler secret put POSTGRES_PRISMA_URL`)
- the GitHub Actions secret `DATABASE_URL` for the crons
- your local `.env.local`, when running migrations or scripts

### 3. Generate Prisma Client

```bash
yarn db:generate
```

This generates the Prisma Client based on your schema in `prisma/schema.prisma`.

### 4. Apply the Schema

The schema is versioned as Prisma migrations under `prisma/migrations/`. The
first entry, `0_init`, is a baseline generated from `prisma/schema.prisma` and
creates every table and index the app uses today.

**Fresh database:**

```bash
yarn db:migrate:deploy
```

**Existing database that was created with `db:push` before migrations were
introduced:** the tables already exist, so tell Prisma the baseline has been
applied instead of running it (one time only):

```bash
yarn prisma migrate resolve --applied 0_init
```

After that, `yarn db:migrate:deploy` applies any later migrations and
`prisma migrate status` reports whether the database is up to date.

**Changing the schema:** edit `prisma/schema.prisma`, run `yarn db:migrate`
against a local database to generate a new migration folder, commit it with the
schema change, then run `yarn db:migrate:deploy` against production. The Workers
build only runs `prisma generate`; it never applies migrations.

`yarn db:push` still works for throwaway local databases, but do not use it on
a database that is tracked by migrations, because the two drift apart.

### 5. Migrate Existing JSON Data

```bash
yarn migrate-json-to-db
```

This script:

- Reads `data/history.json` and `data/history-archive.json`
- Deduplicates records by timestamp
- Inserts all historical data into PostgreSQL
- Shows progress and summary

Expected output:

```
✓ Loaded 1500 records from history.json
✓ Loaded 811 records from history-archive.json
📊 Total unique records to migrate: 2000
  Progress: 2000/2000 records processed
✓ Inserted: 2000 new records
📊 Total records in database: 2000
📅 Date range: 2021-06-19 to 2024-11-27
✓ Migration successful!
```

## Database Schema

### HistoricalRecord Model

```prisma
model HistoricalRecord {
  id        BigInt   @id @default(autoincrement())
  timestamp DateTime @unique

  // Supply metrics
  burnedSupply       Decimal
  mintedSupply       Decimal
  totalSupply        Decimal
  circulatingSupply  Decimal
  restrictedSupply   Decimal?
  communitySupply    Decimal?

  // Staking metrics
  inflationRate Decimal
  totalStaked   Decimal?
  stakingApr    Decimal?
  stakingRate   Decimal?

  // Distribution parameters (JSON)
  distributionProportions            Json?
  osmoTakerFeeDistribution           Json?
  nonOsmoTakerFeeDistribution        Json?
  communityPoolDenomWhitelist        String[]
  communityPoolDenomToSwapNonWhitelistedAssetsTo String?

  // Revenue metrics
  txnFeesRevenue    Decimal?
  takerFeesRevenue  Decimal?
  protorevRevenue   Decimal?
  mevRevenue        Decimal?
  totalRevenue      Decimal?

  // Metadata
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([timestamp(sort: Desc)])
  @@map("historical_records")
}
```

## Useful Commands

```bash
# Generate Prisma Client after schema changes
yarn db:generate

# Push schema changes to a throwaway local database (no migration history)
yarn db:push

# Create a migration from schema changes (local dev database)
yarn db:migrate

# Apply committed migrations (production)
yarn db:migrate:deploy

# Open Prisma Studio (database GUI)
yarn db:studio

# Migrate JSON data to database
yarn migrate-json-to-db
```

## Development Workflow

### Local Development

1. Set `DATABASE_URL` and `POSTGRES_PRISMA_URL` in `.env.local` (see step 2)
2. Generate Prisma Client: `yarn db:generate`
3. Run dev server: `yarn dev`

The app will automatically use the database if `POSTGRES_PRISMA_URL` or `DATABASE_URL` is set.

### Fallback to JSON Files

If database is not configured, the app falls back to JSON file storage in `data/history.json`.

## Production Deployment

The site runs on Cloudflare Workers (see the README's Deployment section):

1. The Worker reads the database URL from its `POSTGRES_PRISMA_URL` secret
2. The build's `prisma generate` runs without a database URL (`prisma.config.ts` tolerates it unset)
3. Schema changes are applied by hand with `yarn db:migrate:deploy`

## Querying Examples

### Using Prisma Client

```typescript
import { prisma } from "@/lib/database";

// Get all records (paginated)
const records = await prisma.historicalRecord.findMany({
  take: 100,
  skip: 0,
  orderBy: { timestamp: "desc" },
});

// Get records for date range
const rangeRecords = await prisma.historicalRecord.findMany({
  where: {
    timestamp: {
      gte: new Date("2024-01-01"),
      lte: new Date("2024-12-31"),
    },
  },
  orderBy: { timestamp: "asc" },
});

// Get latest record
const latest = await prisma.historicalRecord.findFirst({
  orderBy: { timestamp: "desc" },
});

// Count total records
const count = await prisma.historicalRecord.count();
```

## Troubleshooting

### "Database not configured"

**Solution**: Set `DATABASE_URL` (and `POSTGRES_PRISMA_URL`) in `.env.local`.

### "Prisma Client not generated"

**Solution**: Run `yarn db:generate`.

### Migration fails with "column does not exist"

**Solution**: Run `yarn db:migrate:deploy` to bring the schema up to date (or
`yarn prisma migrate resolve --applied 0_init` first if the database predates
the migrations directory, see step 4).

### Connection timeout errors

**Solution**:

- Check the database status in the Prisma console
- Verify the connection string is the direct `db.prisma.io:5432` URL
- Consider increasing connection timeout in `prisma/schema.prisma`

## Cost & Limits

The Prisma Postgres account is shared with the alloy dashboard, and its limits
(operations per month, storage) are account-wide. OSMOscope keeps its writes
small: rate-limit readings are capped and pruned daily (`lib/retention.ts`).

## Support

- **Prisma Docs**: https://www.prisma.io/docs
- **Prisma Postgres Docs**: https://www.prisma.io/docs/postgres
- **OSMOscope Issues**: https://github.com/osmosis-labs/osmoscope/issues
