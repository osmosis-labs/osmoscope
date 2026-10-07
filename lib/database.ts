import type { PrismaClient as PrismaClientType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "./logger";

// Prisma's Node entry compiles its query-compiler Wasm at runtime, which
// Cloudflare Workers forbid. Its Workers entry (`.prisma/client/edge`)
// imports the Wasm as a module instead, but the Worker bundler resolves
// `@prisma/client` with the `node` condition, which Prisma lists first, so the
// Workers entry is required by name there. Both are server-external packages
// (next.config.ts), so Node (scripts, local dev, the crons) never loads the
// edge entry.
type PrismaClient = PrismaClientType;
const { PrismaClient } = (
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers"
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(".prisma/client/edge")
    : // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@prisma/client")
) as typeof import("@prisma/client");

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/next-js-best-practices

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Prisma 7 requires a driver adapter for the database connection; the
// connection URL is no longer read from the schema. Prefer the pooled
// POSTGRES_PRISMA_URL (the Worker secret), falling back to DATABASE_URL for
// the crons, scripts and local Docker development.
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
const createClient = (url: string | undefined) =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: poolMax,
      idleTimeoutMillis: 10_000,
    }),
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

// On Cloudflare Workers a database connection belongs to the request that
// opened it: a module-level pool reused by a later request fails ("Cannot
// perform I/O on behalf of a different request"). There each request gets its
// own client, keyed on that request's execution context, connecting through
// Hyperdrive (which pools connections in front of Prisma Postgres) when the
// HYPERDRIVE binding exists. Everywhere else (local, scripts, crons) there is
// no Cloudflare context and one client is shared as before.
type CloudflareContext = {
  env: { HYPERDRIVE?: { connectionString: string } };
  ctx: object;
};
const requestContext = (): CloudflareContext | undefined =>
  (globalThis as unknown as Record<symbol, CloudflareContext | undefined>)[
    Symbol.for("__cloudflare-context__")
  ];
const perRequest = new WeakMap<object, PrismaClient>();

const currentClient = (): PrismaClient => {
  const cf = requestContext();
  if (cf?.ctx) {
    let client = perRequest.get(cf.ctx);
    if (!client) {
      client = createClient(
        cf.env.HYPERDRIVE?.connectionString ?? connectionString
      );
      perRequest.set(cf.ctx, client);
    }
    return client;
  }
  globalForPrisma.prisma ??= createClient(connectionString);
  return globalForPrisma.prisma;
};

// The same `prisma` every module imports, resolving to the current request's
// client on each use.
export const prisma = new Proxy({} as PrismaClient, {
  get(_, prop) {
    const client = currentClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

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
