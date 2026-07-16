import { NextResponse } from "next/server";
import { fetchSymbolLogoMap } from "@/lib/asset-logos";

// Symbol -> logo URI map for asset rows (treasury holdings and friends).
// Logos change essentially never, so cache aggressively at every layer.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

let cache: { at: number; map: Record<string, string> } | null = null;

export async function GET() {
  if (!cache || Date.now() - cache.at > 60 * 60_000) {
    const map = await fetchSymbolLogoMap(); // never throws; {} on failure
    if (Object.keys(map).length > 0) cache = { at: Date.now(), map };
  }
  return NextResponse.json(
    { logos: cache?.map ?? {} },
    {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    }
  );
}
