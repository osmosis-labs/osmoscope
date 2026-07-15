import { useQuery } from "@tanstack/react-query";
import type { UnbondingSchedule } from "@/lib/validators";

// The route augments the live schedule with the per-completion-day history
// series (UndelegationDay: backfilled + cron-written, keyed by completion day)
// and when the forecast fan-out was computed (for staleness display).
export interface UndelegationsResponse extends UnbondingSchedule {
  history: { date: string; amountCompleting: number }[];
  computedAt: string | null;
}

async function fetchUndelegations(): Promise<UndelegationsResponse> {
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
