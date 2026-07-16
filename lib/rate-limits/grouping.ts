// Pure derivation of the card's per-asset view from snapshot paths: grouping
// by denom, binding-window selection, and display ranking. Extracted from the
// component so the binding semantics are unit-testable (grouping.test.ts).
import type { PathUtilization, WindowUtilization } from "./snapshot";

// Absolute remaining capacity in a window's binding direction, in BASE units
// (comparable across windows of the same denom without a price). Null when the
// window has no computable utilization.
export function remainingBase(w: WindowUtilization): number | null {
  if (w.utilizationPct == null || !w.direction || !w.channelValue) return null;
  const chan = Number(w.channelValue);
  const dirPct = w.direction === "in" ? w.recvPct : w.sendPct;
  const inflow = Number(w.inflow);
  const outflow = Number(w.outflow);
  const used =
    w.direction === "in"
      ? Math.max(0, inflow - outflow)
      : Math.max(0, outflow - inflow);
  return Math.max(0, chan * (dirPct / 100) - used);
}

// One asset's rate-limit summary: every (channel, window) pair for its denom.
// The headline is the BINDING window — the one with the least absolute
// capacity remaining, i.e. the first that would block a transfer — not simply
// the highest percentage (a small-cap Day window can have less headroom than a
// big-cap Week window at a higher %). When two windows are effectively tied on
// remaining capacity (within 10% of each other), the one with the LONGEST time
// to reset wins: it blocks for longer, so it's the operationally dominant
// constraint.
export interface AssetGroup<P extends PathUtilization = PathUtilization> {
  denom: string;
  symbol: string;
  paths: P[];
  binding: {
    path: P;
    window: WindowUtilization;
    remaining: number;
  } | null;
}

export function headlinePct(g: AssetGroup<PathUtilization>): number | null {
  return g.binding?.window.utilizationPct ?? null;
}

// Nanosecond period_end as a comparable bigint; malformed values sort first
// (never win a tie-break).
function periodEndNs(w: WindowUtilization): bigint {
  try {
    return BigInt(w.periodEnd);
  } catch {
    return 0n;
  }
}

// Two remaining-capacity figures count as tied when the smaller is within 10%
// of the larger (covers exact ties, including both-zero when two windows are
// simultaneously blocked).
function remainingTied(a: number, b: number): boolean {
  return Math.min(a, b) >= 0.9 * Math.max(a, b);
}

// Group paths by denom, resolve each group's binding window, and rank:
// tightest assets first (highest binding-window utilization), then the quiet
// ones (no computable current-window utilization) alphabetically — a stable,
// meaningful order for the show-all view.
export function buildAssetGroups<P extends PathUtilization>(
  paths: P[]
): AssetGroup<P>[] {
  const groups = new Map<string, AssetGroup<P>>();
  for (const p of paths) {
    const g = groups.get(p.denom) ?? {
      denom: p.denom,
      symbol: p.symbol,
      paths: [],
      binding: null,
    };
    g.paths.push(p);
    for (const w of p.windows) {
      const remaining = remainingBase(w);
      if (remaining == null) continue;
      if (g.binding == null) {
        g.binding = { path: p, window: w, remaining };
      } else if (remainingTied(remaining, g.binding.remaining)) {
        // Effectively tied on headroom: surface the window that stays binding
        // the longest (furthest period_end).
        if (periodEndNs(w) > periodEndNs(g.binding.window)) {
          g.binding = { path: p, window: w, remaining };
        }
      } else if (remaining < g.binding.remaining) {
        g.binding = { path: p, window: w, remaining };
      }
    }
    groups.set(p.denom, g);
  }
  return [...groups.values()].sort((a, b) => {
    const ap = headlinePct(a);
    const bp = headlinePct(b);
    if (ap != null && bp != null) return bp - ap;
    if (ap != null) return -1;
    if (bp != null) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
}
