import { useQuery } from "@tanstack/react-query";
import type { HistoricalRecord } from "@/lib/historical-file";

async function fetchHistoricalData(): Promise<HistoricalRecord[]> {
  const response = await fetch("/api/history");
  if (!response.ok) {
    throw new Error("Failed to fetch historical data");
  }
  return response.json();
}

// Historical snapshot series for the charts. Mirrors useOsmosisMetrics so the
// charts get loading/error/caching from React Query instead of a hand-rolled
// useEffect + setState fetch. History only changes once a day (the snapshot
// cron), so it can be cached generously.
// `enabled: false` holds the request back, e.g. until the top of a page has
// loaded, so the ~230 KB download doesn't compete with it.
export function useHistoricalData({
  enabled = true,
}: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["historical-data"],
    queryFn: fetchHistoricalData,
    enabled,
    staleTime: 30 * 60_000, // 30 min — history updates at most once/day
    refetchInterval: 30 * 60_000,
  });
}
