import { NextResponse } from "next/server";
import { prisma, isDatabaseEnabled } from "@/lib/database";
import { logger } from "@/lib/logger";

// A validator's logo, stored by the snapshot cron (lib/validator-logos.ts) and
// served from our own origin for the voting-power treemap and the tables.
// Validators without one are redirected to the Osmosis icon (a static asset).
//
// Database reads are bounded: each instance keeps the SET of operators that
// have a logo, refreshed hourly with one small query, and only reads bytes for
// those. Any other address, including made-up ones, is answered without the
// database. Images and redirects carry a day of cache.
export const dynamic = "force-dynamic";

const OPERATOR_RE = /^osmovaloper1[02-9ac-hj-np-z]{38}$/;
const DAY_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";
const LIST_TTL_MS = 60 * 60_000;
const PLACEHOLDER = "/Osmosis_Icon_128.png";

let known: { at: number; operators: Set<string> } | null = null;
// While the database is failing, retry the list at most once a minute.
let lastAttempt = 0;
// The list query in progress. A page load asks for ~30 logos at once, so every
// request that arrives while it runs waits for it rather than answering 503.
let inflight: Promise<void> | null = null;

async function operatorsWithLogo(): Promise<Set<string> | null> {
  if (known && Date.now() - known.at < LIST_TTL_MS) return known.operators;
  if (!inflight && Date.now() - lastAttempt >= 60_000) {
    lastAttempt = Date.now();
    inflight = (async () => {
      try {
        const rows = await prisma.validatorLogo.findMany({
          where: { contentType: { not: null } },
          select: { operatorAddress: true },
        });
        known = {
          at: Date.now(),
          operators: new Set(rows.map((r) => r.operatorAddress)),
        };
      } catch (error) {
        logger.error("Validator logo list failed:", error);
      } finally {
        inflight = null;
      }
    })();
  }
  if (inflight) await inflight;
  return known?.operators ?? null;
}

const placeholder = () =>
  new NextResponse(null, {
    status: 302,
    headers: { Location: PLACEHOLDER, "Cache-Control": DAY_CACHE },
  });

const unavailable = () =>
  new NextResponse(null, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ operator: string }> }
) {
  const { operator } = await params;
  if (!OPERATOR_RE.test(operator))
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": DAY_CACHE },
    });
  if (!isDatabaseEnabled()) return placeholder();

  const operators = await operatorsWithLogo();
  if (!operators) return unavailable();
  if (!operators.has(operator)) return placeholder();

  try {
    const row = await prisma.validatorLogo.findUnique({
      where: { operatorAddress: operator },
      select: { contentType: true, data: true },
    });
    if (!row?.data || !row.contentType) return placeholder();
    return new NextResponse(new Uint8Array(row.data), {
      headers: {
        "Content-Type": row.contentType,
        "Cache-Control": DAY_CACHE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("Validator logo route failed:", error);
    return unavailable();
  }
}
