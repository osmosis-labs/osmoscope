// Snapshot builder for the IBC rate-limit monitor.
//
// Turns the raw contract dump into per-window utilization figures. The
// contract enforces NET flow per window: capacity = channel_value * pct / 100
// and the binding number is max(net inflow / recv cap, net outflow / send
// cap). channel_value is snapshotted by the contract at window start, so a
// window can legitimately exceed 100% utilization of a stale snapshot only by
// blocking; anything at or above 100% means transfers in that direction are
// being rejected.
//
// Two states are excluded from utilization (but kept in the stored payload):
// - expired windows (period_end in the past): the contract lazily resets them
//   on the next transfer, so their counters no longer bind anything;
// - directions with a 0% cap: deliberate one-way wind-down closures, blocked
//   by design and pointless to alert on.
import {
  fetchRateLimitPaths,
  fetchSymbolMap,
  type ContractRateLimit,
} from "./fetch";

export interface WindowUtilization {
  quotaName: string;
  durationSeconds: number;
  sendPct: number;
  recvPct: number;
  channelValue: string | null;
  inflow: string;
  outflow: string;
  periodEnd: string; // nanosecond timestamp string, as stored
  windowActive: boolean;
  // Percent of the binding cap consumed (0-100+), or null when nothing is
  // computable for this window (expired, no channel value, or both caps 0).
  utilizationPct: number | null;
  // Which direction is binding when utilizationPct is set.
  direction: "in" | "out" | null;
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

function computeWindow(
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
    sendPct: quota.max_percentage_send,
    recvPct: quota.max_percentage_recv,
    channelValue: quota.channel_value,
    inflow: flow.inflow,
    outflow: flow.outflow,
    periodEnd: flow.period_end,
    windowActive,
    utilizationPct: null,
    direction: null,
  };

  // Number() on Uint256 strings loses precision beyond 2^53, which is fine:
  // these values only ever enter ratios.
  const channelValue = quota.channel_value ? Number(quota.channel_value) : 0;
  if (!windowActive || channelValue <= 0) return base;

  const inflow = Number(flow.inflow);
  const outflow = Number(flow.outflow);
  const netIn = Math.max(0, inflow - outflow);
  const netOut = Math.max(0, outflow - inflow);

  let utilization: number | null = null;
  let direction: "in" | "out" | null = null;
  if (quota.max_percentage_recv > 0) {
    const pct =
      (netIn / (channelValue * (quota.max_percentage_recv / 100))) * 100;
    utilization = pct;
    direction = "in";
  }
  if (quota.max_percentage_send > 0) {
    const pct =
      (netOut / (channelValue * (quota.max_percentage_send / 100))) * 100;
    if (utilization === null || pct > utilization) {
      utilization = pct;
      direction = "out";
    }
  }
  if (utilization === null) return base;
  return {
    ...base,
    utilizationPct: Math.round(utilization * 100) / 100,
    direction,
  };
}

export async function buildRateLimitSnapshot(): Promise<RateLimitSnapshotData> {
  const [{ paths, endpoint }, symbols] = await Promise.all([
    fetchRateLimitPaths(),
    fetchSymbolMap(),
  ]);
  const nowMs = Date.now();

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
