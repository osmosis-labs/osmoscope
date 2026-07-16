import { NextResponse } from "next/server";
import { prisma, isDatabaseEnabled } from "@/lib/database";
import {
  buildRateLimitSnapshot,
  type RateLimitSnapshotData,
} from "@/lib/rate-limits/snapshot";
import { buildPriceMap, type PriceMap } from "@/lib/treasury/prices";
import { fetchLogoMap } from "@/lib/rate-limits/fetch";
import { logger } from "@/lib/logger";

// IBC rate-limit utilization for the /network page: the latest per-path
// snapshot (written every 15 minutes by /api/cron/rate-limits). Serves the
// stored snapshot; only if none exists yet (fresh deploy before the first
// cron run) does it fall back to one live contract dump, without persisting
// it. Per-denom flow history accumulates in rate_limit_readings, unqueried
// here until something charts it.
//
// Each path is enriched with the asset's exponent and USD price (Numia via the
// treasury price map) so the card can express channel value and remaining
// capacity in display units and dollars. Enrichment is best-effort: a missing
// price/exponent surfaces as null, never a fake zero.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Numia's /tokens/v2/all is a heavyweight call; cache the map in module scope
// for the edge-cache window so warm instances don't refetch per request.
let priceCache: { at: number; map: PriceMap } | null = null;
async function getPriceMap(): Promise<PriceMap | null> {
  if (priceCache && Date.now() - priceCache.at < 5 * 60_000)
    return priceCache.map;
  try {
    const map = await buildPriceMap();
    priceCache = { at: Date.now(), map };
    return map;
  } catch (e) {
    logger.warn(
      `Rate-limits price enrichment unavailable: ${e instanceof Error ? e.message : String(e)}`
    );
    // Serve a stale map over none at all.
    return priceCache?.map ?? null;
  }
}

// Logos change essentially never; a long module-scope cache is plenty.
let logoCache: { at: number; map: Map<string, string> } | null = null;
async function getLogoMap(): Promise<Map<string, string>> {
  if (logoCache && Date.now() - logoCache.at < 60 * 60_000)
    return logoCache.map;
  const map = await fetchLogoMap(); // never throws; empty map on failure
  if (map.size > 0) logoCache = { at: Date.now(), map };
  return map.size > 0 ? map : (logoCache?.map ?? map);
}

export async function GET() {
  try {
    let current: RateLimitSnapshotData | null = null;

    if (isDatabaseEnabled()) {
      const latest = await prisma.rateLimitSnapshot.findFirst({
        orderBy: { timestamp: "desc" },
      });
      if (latest) current = latest.data as unknown as RateLimitSnapshotData;
    }

    if (!current) {
      logger.warn(
        "No stored rate-limit snapshot; falling back to a live contract dump (first run?)."
      );
      current = await buildRateLimitSnapshot();
    }

    // Enrich each path with exponent + USD price for display-unit conversion,
    // and the assetlist logo. Numia prices of 0 mean "unpriced", not free —
    // surface null instead.
    const [prices, logos] = await Promise.all([getPriceMap(), getLogoMap()]);
    const paths = current.paths.map((p) => {
      const info = prices?.[p.denom];
      return {
        ...p,
        exponent: info?.exponent ?? null,
        priceUsd: info != null && info.price > 0 ? info.price : null,
        logoUri: logos.get(p.denom) ?? null,
      };
    });

    return NextResponse.json(
      { current: { ...current, paths } },
      {
        headers: {
          // The cron writes every 15 minutes; a 5-minute edge cache keeps the
          // page fresh without hitting the DB per viewer.
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (error) {
    logger.error("Rate-limits route failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
