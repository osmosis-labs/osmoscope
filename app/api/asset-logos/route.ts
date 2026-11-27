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
let lastAttempt = 0;
// Coalesce concurrent cold/stale refreshes so simultaneous requests wait for
// the in-flight fetch instead of hitting the backoff gate and getting {}.
let inflight: Promise<void> | null = null;

export async function GET() {
  const stale = !cache || Date.now() - cache.at > 60 * 60_000;
  if (stale && !inflight && Date.now() - lastAttempt > 60_000) {
    lastAttempt = Date.now();
    inflight = (async () => {
      try {
        const map = await fetchSymbolLogoMap(); // never throws; {} on failure
        if (Object.keys(map).length > 0) cache = { at: Date.now(), map };
      } finally {
        inflight = null;
      }
    })();
  }
  if (inflight) await inflight;
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
