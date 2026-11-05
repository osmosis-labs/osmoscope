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
export function useHistoricalData() {
  return useQuery({
    queryKey: ["historical-data"],
    queryFn: fetchHistoricalData,
    staleTime: 30 * 60_000, // 30 min — history updates at most once/day
    refetchInterval: 30 * 60_000,
  });
}
