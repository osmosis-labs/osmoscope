import { useQuery } from "@tanstack/react-query";
import type { UnbondingSchedule } from "@/lib/validators";

async function fetchUndelegations(): Promise<UnbondingSchedule> {
  const response = await fetch("/api/undelegations");
  if (!response.ok) {
    throw new Error("Failed to fetch undelegations");
  }
  return response.json();
}

// The pending-undelegation schedule (true total + per-day amounts). The route
// enumerates all validators (~13s) and is edge-cached 30 min, so cache generously
// client-side too.
export function useUndelegations() {
  return useQuery({
    queryKey: ["undelegations"],
    queryFn: fetchUndelegations,
    staleTime: 15 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}
