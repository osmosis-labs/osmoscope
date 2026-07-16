import { useQuery } from "@tanstack/react-query";
import type {
  PathUtilization,
  RateLimitSnapshotData,
} from "@/lib/rate-limits/snapshot";

// A path as served by /api/rate-limits: the stored snapshot shape enriched
// with the asset's exponent, USD price and assetlist logo (null when
// unresolvable — a missing price is surfaced, never faked as zero).
export interface EnrichedPathUtilization extends PathUtilization {
  exponent: number | null;
  priceUsd: number | null;
  logoUri: string | null;
}

// The latest per-path rate-limit snapshot (per-denom flow HISTORY accumulates
// in the rate_limit_readings table for analysis; nothing on the page charts it
// yet).
export interface RateLimitsResponse {
  current: Omit<RateLimitSnapshotData, "paths"> & {
    paths: EnrichedPathUtilization[];
  };
}

async function fetchRateLimits(): Promise<RateLimitsResponse> {
  const response = await fetch("/api/rate-limits");
  if (!response.ok) {
    throw new Error("Failed to fetch rate limits");
  }
  return response.json();
}

// The cron refreshes the snapshot every 15 minutes and the route is
// edge-cached 5, so cache client-side accordingly.
export function useRateLimits() {
  return useQuery({
    queryKey: ["rate-limits"],
    queryFn: fetchRateLimits,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}
