import { useQuery } from "@tanstack/react-query";
import type { TreasurySnapshotData } from "@/lib/treasury/snapshot";

async function fetchTreasuryData(): Promise<TreasurySnapshotData> {
  const response = await fetch("/api/treasury");
  if (!response.ok) {
    // Distinguish "not built yet" (503) from a genuine failure so the UI can
    // show a friendlier "first snapshot pending" message.
    if (response.status === 503) {
      throw new Error("No treasury snapshot available yet");
    }
    throw new Error("Failed to fetch treasury data");
  }
  return response.json();
}

// Latest community-pool / DAO-treasury snapshot. Refreshed hourly by the treasury
// cron, so cache generously and refetch on that cadence.
export function useTreasuryData() {
  return useQuery({
    queryKey: ["treasury-data"],
    queryFn: fetchTreasuryData,
    staleTime: 15 * 60_000, // 15 min — snapshot refreshes hourly
    refetchInterval: 15 * 60_000,
  });
}
