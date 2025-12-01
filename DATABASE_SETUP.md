# Database Setup Guide

This guide explains how to set up and migrate to Vercel Postgres for Osmometer's historical data storage.

## Overview

Osmometer now uses **Vercel Postgres** (PostgreSQL) with **Prisma ORM** for storing historical OSMO tokenomics data. This provides:

- ✅ Efficient querying with indexes
- ✅ Pagination and filtering support
- ✅ ACID guarantees (no more race conditions)
- ✅ Type-safe database access
- ✅ Scalability for growing datasets

## Prerequisites

- Vercel account with the project connected
- Vercel CLI installed: `npm i -g vercel`
- Node.js 18+ and npm/yarn

## Setup Steps

### 1. Create Vercel Postgres Database

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Navigate to your Osmometer project
3. Go to **Storage** tab
4. Click **Create Database**
5. Select **Postgres**
6. Choose database name: `osmometer-db`
7. Select region (same as your deployment region for best performance)
8. Click **Create**

### 2. Connect Database to Project

Vercel will automatically:

- Create the database
- Set up connection pooling
- Add environment variables to your project

### 3. Pull Environment Variables Locally

```bash
# Make sure you're in the project directory
cd osmometer

# Pull Vercel environment variables
vercel env pull .env.local
```

This creates `.env.local` with the following variables:

- `POSTGRES_URL` - Direct connection string
- `POSTGRES_PRISMA_URL` - Pooled connection string
- `POSTGRES_URL_NON_POOLING` - Non-pooled connection string
- `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`

### 4. Generate Prisma Client

```bash
npm run db:generate
```

This generates the Prisma Client based on your schema in `prisma/schema.prisma`.

### 5. Run Database Migration

```bash
npm run db:migrate
```

This creates the database schema (tables, indexes, triggers).

### 6. Migrate Existing JSON Data

```bash
npm run migrate-json-to-db
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
npm run db:generate

# Push schema changes without creating migration
npm run db:push

# Create and apply migration
npm run db:migrate

# Open Prisma Studio (database GUI)
npm run db:studio

# Migrate JSON data to database
npm run migrate-json-to-db
```

## Development Workflow

### Local Development

1. Pull environment variables: `vercel env pull .env.local`
2. Generate Prisma Client: `npm run db:generate`
3. Run dev server: `npm run dev`

The app will automatically use the database if `POSTGRES_PRISMA_URL` is set.

### Fallback to JSON Files

If database is not configured, the app falls back to JSON file storage in `data/history.json`.

## Production Deployment

No additional setup needed! Vercel automatically:

1. Connects to the Postgres database
2. Sets environment variables
3. Generates Prisma Client during build

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

**Solution**: Run `vercel env pull .env.local` to get database credentials.

### "Prisma Client not generated"

**Solution**: Run `npm run db:generate`.

### Migration fails with "column does not exist"

**Solution**: Run `npm run db:migrate` to create the schema.

### Connection timeout errors

**Solution**:

- Check Vercel dashboard for database status
- Verify `POSTGRES_PRISMA_URL` is using connection pooling
- Consider increasing connection timeout in `prisma/schema.prisma`

## Cost & Limits

### Vercel Postgres Free Tier

- **Storage**: 256 MB
- **Compute**: 60 hours/month
- **Databases**: 1 database

For Osmometer's use case (daily snapshots, ~1000 records/year), the free tier should last 10+ years.

### Upgrade Options

If you need more:

- **Pro Plan**: $20/month
  - 512 MB storage
  - 100 hours compute
  - 10 databases

## Migration from JSON Files

The database approach offers:

| Feature           | JSON Files           | Vercel Postgres               |
| ----------------- | -------------------- | ----------------------------- |
| Query speed       | O(n) scan            | O(log n) with indexes         |
| Pagination        | Load all + filter    | Native LIMIT/OFFSET           |
| Concurrent writes | Race conditions      | ACID transactions             |
| Memory usage      | Load all into memory | Stream results                |
| Backup            | Manual GitHub push   | Automatic Vercel backups      |
| Scale limit       | ~10 MB practical     | 256 MB (free), more with paid |

## Next Steps

After successful migration:

1. Test API endpoints: `/api/history`, `/api/osmosis-metrics`
2. Verify chart data loads correctly
3. Monitor performance in Vercel dashboard
4. (Optional) Keep JSON files as backup for 1 week
5. (Optional) Update cron jobs to write directly to database

## Support

- **Prisma Docs**: https://www.prisma.io/docs
- **Vercel Postgres Docs**: https://vercel.com/docs/storage/vercel-postgres
- **Osmometer Issues**: https://github.com/your-org/osmometer/issues
