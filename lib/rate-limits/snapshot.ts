// Snapshot builder for the IBC rate-limit monitor.
//
// Turns the raw contract dump into per-window utilization figures. Each
// direction of a quota carries up to two bounds (contract 0.2.0; earlier
// entries have only the first):
// - a percentage of channel_value, enforced on the NET flow
//   (inflow - outflow, or the reverse): cap = channel_value * pct / 100;
// - an absolute amount in base units, enforced on the GROSS flow (inflow or
//   outflow as stored).
// The window's utilization is the bound closest to tripping across both
// directions. channel_value is snapshotted by the contract at window start,
// so a window can legitimately exceed 100% utilization of a stale snapshot
// only by blocking; anything at or above 100% means transfers in that
// direction are being rejected. Percentages above 100 are real (no clamp).
//
// Two states are excluded from utilization (but kept in the stored payload):
// - expired windows (period_end in the past): the contract lazily resets them
//   on the next transfer, so their counters no longer bind anything;
// - directions with a 0% or 0 absolute cap: deliberate one-way wind-down
//   closures, blocked by design and pointless to alert on.
import {
  fetchRateLimitPaths,
  fetchSymbolMap,
  type ContractRateLimit,
} from "./fetch";

export interface WindowUtilization {
  quotaName: string;
  durationSeconds: number;
  // Whole-percent caps; null when the quota has no percentage bound in that
  // direction.
  sendPct: number | null;
  recvPct: number | null;
  // Absolute caps in base units; null when the quota has none in that
  // direction. Absent on snapshots stored before the monitor read them.
  maxAbsoluteSend?: string | null;
  maxAbsoluteRecv?: string | null;
  channelValue: string | null;
  inflow: string;
  outflow: string;
  periodEnd: string; // nanosecond timestamp string, as stored
  windowActive: boolean;
  // Percent of the binding cap consumed (0-100+), or null when nothing is
  // computable for this window (expired, every direction closed, or only
  // percentage bounds and no channel value).
  utilizationPct: number | null;
  // Which direction is binding when utilizationPct is set.
  direction: "in" | "out" | null;
  // Which kind of bound is binding when utilizationPct is set. Absent on
  // snapshots stored before absolute bounds existed (always percentage).
  bound?: "percentage" | "absolute" | null;
}

export interface PathUtilization {
  channel: string;
  denom: string;
  symbol: string;
  windows: WindowUtilization[];
  maxUtilizationPct: number | null;
}

export interface RateLimitSnapshotData {
  timestamp: string;
  endpoint: string;
  pathCount: number;
  maxUtilizationPct: number;
  paths: PathUtilization[];
}

export function shortDenom(denom: string): string {
  return denom.length > 26 ? `${denom.slice(0, 14)}…${denom.slice(-6)}` : denom;
}

export function computeWindow(
  limit: ContractRateLimit,
  nowMs: number
): WindowUtilization {
  const { quota, flow } = limit;
  // Nanoseconds -> milliseconds via BigInt so 19-digit strings stay exact.
  const periodEndMs = Number(BigInt(flow.period_end) / 1_000_000n);
  const windowActive = periodEndMs > nowMs;

  const base: WindowUtilization = {
    quotaName: quota.name,
    durationSeconds: quota.duration,
    sendPct: quota.max_percentage_send ?? null,
    recvPct: quota.max_percentage_recv ?? null,
    maxAbsoluteSend: quota.max_absolute_send ?? null,
    maxAbsoluteRecv: quota.max_absolute_recv ?? null,
    channelValue: quota.channel_value,
    inflow: flow.inflow,
    outflow: flow.outflow,
    periodEnd: flow.period_end,
    windowActive,
    utilizationPct: null,
    direction: null,
    bound: null,
  };
  if (!windowActive) return base;

  // Number() on Uint256 strings loses precision beyond 2^53, which is fine:
  // these values only ever enter ratios.
  const channelValue = quota.channel_value ? Number(quota.channel_value) : 0;
  const inflow = Number(flow.inflow);
  const outflow = Number(flow.outflow);

  // The binding figure is the bound closest to tripping, across both
  // directions and both kinds: percentage bounds against the NET flow,
  // absolute bounds against the GROSS flow, never one divided by the other.
  // On a tie the earlier candidate (in before out, percentage before
  // absolute) is kept.
  let best: {
    pct: number;
    direction: "in" | "out";
    bound: "percentage" | "absolute";
  } | null = null;
  for (const direction of ["in", "out"] as const) {
    const pctCap = direction === "in" ? base.recvPct : base.sendPct;
    const absCap =
      direction === "in" ? base.maxAbsoluteRecv : base.maxAbsoluteSend;
    // A zero bound closes the direction by design (see header).
    if (pctCap === 0 || absCap === "0") continue;
    const gross = direction === "in" ? inflow : outflow;
    const net = Math.max(
      0,
      direction === "in" ? inflow - outflow : outflow - inflow
    );
    const caps: Array<["percentage" | "absolute", number, number]> = [];
    if (pctCap != null && channelValue > 0) {
      caps.push(["percentage", net, channelValue * (pctCap / 100)]);
    }
    if (absCap != null) caps.push(["absolute", gross, Number(absCap)]);
    // A cached channel value of exactly zero makes the percentage cap zero,
    // so any net transfer in this direction is rejected: report it as
    // blocking rather than letting an absolute bound hide it. A null channel
    // value only means the contract has not cached one yet (it does on the
    // next transfer), so that stays not computable.
    const zeroPctCap = pctCap != null && quota.channel_value === "0";
    if (zeroPctCap && (best === null || 100 > best.pct)) {
      best = { pct: 100, direction, bound: "percentage" };
    }
    for (const [bound, used, cap] of caps) {
      const pct = (used / cap) * 100;
      if (best === null || pct > best.pct) best = { pct, direction, bound };
    }
  }
  if (best === null) return base;
  return {
    ...base,
    utilizationPct: Math.round(best.pct * 100) / 100,
    direction: best.direction,
    bound: best.bound,
  };
}

// The live state, or with `at` the state at a past block (`timeMs` is that
// block's time, so windows are judged active as of then).
export async function buildRateLimitSnapshot(at?: {
  height: number;
  timeMs: number;
}): Promise<RateLimitSnapshotData> {
  const [{ paths, endpoint }, symbols] = await Promise.all([
    fetchRateLimitPaths(at?.height),
    fetchSymbolMap(),
  ]);
  const nowMs = at?.timeMs ?? Date.now();

  const pathUtilizations: PathUtilization[] = paths.map((path) => {
    const windows = path.limits.map((limit) => computeWindow(limit, nowMs));
    const utilizations = windows
      .map((w) => w.utilizationPct)
      .filter((pct): pct is number => pct !== null);
    return {
      channel: path.channel,
      denom: path.denom,
      symbol: symbols.get(path.denom) ?? shortDenom(path.denom),
      windows,
      maxUtilizationPct:
        utilizations.length > 0 ? Math.max(...utilizations) : null,
    };
  });

  return {
    timestamp: new Date(nowMs).toISOString(),
    endpoint,
    pathCount: pathUtilizations.length,
    maxUtilizationPct: Math.max(
      0,
      ...pathUtilizations
        .map((p) => p.maxUtilizationPct)
        .filter((pct): pct is number => pct !== null)
    ),
    paths: pathUtilizations,
  };
}
