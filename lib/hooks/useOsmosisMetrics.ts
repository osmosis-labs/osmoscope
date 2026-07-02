import { useQuery } from "@tanstack/react-query";
import type { OsmosisMetrics } from "@/types/osmosis";

async function fetchOsmosisMetrics(): Promise<OsmosisMetrics> {
  const response = await fetch("/api/osmosis-metrics");
  if (!response.ok) {
    // 503 = no snapshot captured yet (fresh deploy before the first cron run).
    // Distinguish it so the UI can show a friendly "pending" message rather than
    // a generic failure, mirroring useTreasuryData.
    if (response.status === 503) {
      throw new Error("No snapshot data available yet");
    }
    throw new Error("Failed to fetch Osmosis metrics");
  }
  return response.json();
}

export function useOsmosisMetrics() {
  return useQuery({
    queryKey: ["osmosis-metrics"],
    queryFn: fetchOsmosisMetrics,
    refetchInterval: 5 * 60_000, // Refetch every 5 minutes
    staleTime: 2 * 60_000, // Consider data stale after 2 minutes
  });
}
