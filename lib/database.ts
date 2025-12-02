import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/next-js-best-practices

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
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
