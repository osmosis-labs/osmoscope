import { useQuery } from "@tanstack/react-query";
import type { OsmosisMetrics } from "@/types/osmosis";

async function fetchOsmosisMetrics(): Promise<OsmosisMetrics> {
  const response = await fetch("/api/osmosis-metrics");
  if (!response.ok) {
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
