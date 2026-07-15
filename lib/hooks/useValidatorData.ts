import { useQuery } from "@tanstack/react-query";
import type { DecentralizationMetrics } from "@/lib/validators";

async function fetchValidatorData(): Promise<DecentralizationMetrics> {
  const response = await fetch("/api/validators");
  if (!response.ok) {
    throw new Error("Failed to fetch validator data");
  }
  return response.json();
}

// Live decentralization metrics (Nakamoto, Gini, voting-power distribution,
// leaderboard, pending undelegations). The validator set changes at most once
// per epoch, so cache generously.
export function useValidatorData() {
  return useQuery({
    queryKey: ["validator-data"],
    queryFn: fetchValidatorData,
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
  });
}
