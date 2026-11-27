import { NextResponse } from "next/server";
import { fetchSymbolLogoMap } from "@/lib/asset-logos";

// Symbol -> logo URI map for asset rows (treasury holdings). Logos change
// essentially never, so cache aggressively at every layer — EXCEPT the empty
// failure result, which must not be pinned into the CDN for an hour.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

let cache: { at: number; map: Record<string, string> } | null = null;
// Negative-result backoff: while upstream is failing, retry at most once a
// minute instead of on every request (each attempt costs two upstream fetches).
// Stamped only after a failed attempt, so concurrent cold requests each fetch
// rather than hitting the gate mid-fetch and getting {}. The refresh stays
// request-scoped: on Workers a promise shared with a request that is later
// cancelled may never settle, which would wedge every waiter on the isolate.
let lastFailure = 0;

export async function GET() {
  const stale = !cache || Date.now() - cache.at > 60 * 60_000;
  if (stale && Date.now() - lastFailure > 60_000) {
    const map = await fetchSymbolLogoMap(); // never throws; {} on failure
    if (Object.keys(map).length > 0) cache = { at: Date.now(), map };
    else lastFailure = Date.now();
  }
  const map = cache?.map ?? {};
  return NextResponse.json(
    { logos: map },
    {
      headers: {
        // An empty map means upstream failure — serve it uncached so the CDN
        // doesn't pin a logo-less page for the full hour (+ SWR day).
        "Cache-Control":
          Object.keys(map).length > 0
            ? "public, s-maxage=3600, stale-while-revalidate=86400"
            : "no-store",
      },
    }
  );
}
