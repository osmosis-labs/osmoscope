// Enumeration of the live IBC rate limiter's configured paths via a raw
// contract-state dump.
//
// The deployed rate limiter contract has no list-all-quotas query, so the only
// complete enumeration is /cosmwasm/wasm/v1/contract/<addr>/state: the
// cw-storage-plus keys under the `flow` namespace decode to (channel, denom)
// and each value is the stored Vec<RateLimit>. Paths with an empty quota list
// carry no limit (residue left behind by removed limits) and are filtered out
// here so downstream code only sees real limits.
import { logger } from "../logger";
import { LCD_BASE_URL } from "../osmosis-lcd";

export const RATE_LIMITER_CONTRACT =
  "osmo17r7qdw2zk6jyw62cvwm6flmhtj9q7zd26r8zc6sqyf0pnaq46cfss8hgxg";

// Primary first. The dump is a handful of plain REST pages (not CosmWasm smart
// queries), so public fallbacks hold up fine when the primary throttles.
const LCD_ENDPOINTS = [
  LCD_BASE_URL,
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
];

// Generated frontend assetlist, used only to label denoms with human-readable
// symbols in alerts. A fetch failure degrades to truncated denoms, never to a
// hard error.
const ASSETLIST_URL =
  "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/generated/frontend/assetlist.json";

// Shapes as stored by the contract (Vec<RateLimit> per path). Amounts are
// Uint256 decimal strings; period_end is a nanosecond timestamp string.
export interface ContractQuota {
  name: string;
  max_percentage_send: number;
  max_percentage_recv: number;
  duration: number;
  channel_value: string | null;
}

export interface ContractFlow {
  inflow: string;
  outflow: string;
  period_end: string;
}

export interface ContractRateLimit {
  quota: ContractQuota;
  flow: ContractFlow;
}

export interface RateLimitPath {
  channel: string;
  denom: string;
  limits: ContractRateLimit[];
}

interface StateModel {
  key: string; // hex
  value: string; // base64
}

interface StatePage {
  models: StateModel[];
  pagination?: { next_key?: string | null };
}

// Decode a cw-storage-plus composite Map key: 2-byte big-endian namespace
// length, namespace bytes, then a 2-byte length-prefixed first component
// (channel) with the raw remainder as the last component (denom).
function decodeFlowKey(
  hexKey: string
): { channel: string; denom: string } | null {
  const raw = Buffer.from(hexKey, "hex");
  if (raw.length < 4) return null;
  const nsLen = raw.readUInt16BE(0);
  if (raw.length < 2 + nsLen + 2) return null;
  if (raw.subarray(2, 2 + nsLen).toString("utf8") !== "flow") return null;
  const rest = raw.subarray(2 + nsLen);
  const chanLen = rest.readUInt16BE(0);
  if (rest.length < 2 + chanLen) return null;
  return {
    channel: rest.subarray(2, 2 + chanLen).toString("utf8"),
    denom: rest.subarray(2 + chanLen).toString("utf8"),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return (await response.json()) as T;
}

async function dumpStateFrom(endpoint: string): Promise<RateLimitPath[]> {
  const paths: RateLimitPath[] = [];
  let nextKey: string | null = null;
  // The LCD caps state pages at 100 entries regardless of the requested limit;
  // ~800 entries today, so cap pages generously as a runaway guard.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({ "pagination.limit": "1000" });
    if (nextKey) params.set("pagination.key", nextKey);
    const data: StatePage = await fetchJson(
      `${endpoint}/cosmwasm/wasm/v1/contract/${RATE_LIMITER_CONTRACT}/state?${params.toString()}`
    );
    for (const model of data.models ?? []) {
      const key = decodeFlowKey(model.key);
      if (!key) continue;
      const limits = JSON.parse(
        Buffer.from(model.value, "base64").toString("utf8")
      ) as ContractRateLimit[];
      if (!Array.isArray(limits) || limits.length === 0) continue;
      paths.push({ ...key, limits });
    }
    nextKey = data.pagination?.next_key ?? null;
    if (!nextKey) break;
  }
  return paths;
}

// Dump every configured rate-limit path, failing over across LCD endpoints.
// A partial dump is never returned: any page failure discards the endpoint.
export async function fetchRateLimitPaths(): Promise<{
  paths: RateLimitPath[];
  endpoint: string;
}> {
  let lastError: unknown = null;
  for (const endpoint of LCD_ENDPOINTS) {
    try {
      const paths = await dumpStateFrom(endpoint);
      return { paths, endpoint };
    } catch (error) {
      lastError = error;
      logger.warn(`Rate-limit state dump failed on ${endpoint}:`, error);
    }
  }
  throw new Error(
    `Rate-limit state dump failed on all LCD endpoints: ${String(lastError)}`
  );
}

// Best-effort denom -> symbol map for readable alerts.
export async function fetchSymbolMap(): Promise<Map<string, string>> {
  try {
    const data = await fetchJson<{
      assets: Array<{ coinMinimalDenom?: string; symbol?: string }>;
    }>(ASSETLIST_URL);
    const map = new Map<string, string>();
    for (const asset of data.assets ?? []) {
      if (asset.coinMinimalDenom && asset.symbol) {
        map.set(asset.coinMinimalDenom, asset.symbol);
      }
    }
    return map;
  } catch (error) {
    logger.warn("Assetlist fetch failed; alerts will show raw denoms:", error);
    return new Map();
  }
}

// Best-effort denom -> logo URI map (SVG preferred) for the dashboard card.
// Display metadata only — deliberately not part of the stored snapshot payload.
export async function fetchLogoMap(): Promise<Map<string, string>> {
  try {
    const data = await fetchJson<{
      assets: Array<{
        coinMinimalDenom?: string;
        logoURIs?: { svg?: string; png?: string };
      }>;
    }>(ASSETLIST_URL);
    const map = new Map<string, string>();
    for (const asset of data.assets ?? []) {
      const logo = asset.logoURIs?.svg ?? asset.logoURIs?.png;
      if (asset.coinMinimalDenom && logo) {
        map.set(asset.coinMinimalDenom, logo);
      }
    }
    return map;
  } catch (error) {
    logger.warn("Assetlist logo fetch failed; card shows symbols only:", error);
    return new Map();
  }
}
