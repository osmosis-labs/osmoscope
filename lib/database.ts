import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "./logger";

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/next-js-best-practices

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Prisma 7 requires a driver adapter for the database connection; the
// connection URL is no longer read from the schema. Prefer the pooled
// POSTGRES_PRISMA_URL (Vercel Postgres), falling back to DATABASE_URL for local
// Docker development.
const connectionString =
  process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL;

// Bound the pg pool size PER INSTANCE. This DB is Prisma Postgres
// (db.prisma.io), which pools connections SERVER-side, so the ceiling that
// matters is the Prisma Postgres PLAN's concurrent-connection limit, not raw
// Postgres max_connections. Without a client cap, pg defaults to 10
// connections per pool, and on Vercel Fluid Compute every warm function
// instance holds its own pool — so the cron fleet (rate-limits every 15 min,
// treasury + revenue hourly, snapshot) plus page-load API routes collectively
// blew past the plan limit. Once it's saturated a new transaction can't
// acquire a connection even within maxWait, surfacing as "Unable to start a
// transaction in the given time" (the recurring rate-limit degraded alert).
// PR #27 raised maxWait, which reduced but didn't eliminate it because the
// real limit was total concurrent connections, not wait time. Keep the
// per-instance pool small (server-side pooling means the client needs very
// few) so many warm instances stay under the plan ceiling. If this still trips
// after deploy, the next lever is the Prisma Postgres plan's connection limit
// (console.prisma.io → the Postgres instance), not more app-side tuning.
// Override with DB_POOL_MAX if the deployment shape changes.
const poolMax = Number(process.env.DB_POOL_MAX) || 2;

// idleTimeoutMillis: release idle connections quickly so a warm-but-idle
// instance stops squatting on a connection other instances (or crons) need.
const adapter = new PrismaPg({
  connectionString,
  max: poolMax,
  idleTimeoutMillis: 10_000,
});

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Check if database is configured
export function isDatabaseEnabled(): boolean {
  return !!(process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL);
}

// Test database connection
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info("Database connection successful");
    return true;
  } catch (error) {
    logger.error("Database connection failed:", error);
    return false;
  }
}

// Close database connection (for cleanup)
export async function closeDatabaseConnection(): Promise<void> {
  await prisma.$disconnect();
}

// Type exports for convenience
export type { HistoricalRecord } from "@prisma/client";
