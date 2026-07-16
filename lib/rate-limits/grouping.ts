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
// big-cap Week window at a higher %).
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
      if (g.binding == null || remaining < g.binding.remaining) {
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
