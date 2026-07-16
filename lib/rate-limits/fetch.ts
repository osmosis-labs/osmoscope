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
import {
  RATE_LIMITER_CONTRACT,
  RATE_LIMIT_LCD_FALLBACKS,
} from "@/config/rate-limits";

export { RATE_LIMITER_CONTRACT };

// Primary first, then the config-listed public fallbacks.
const LCD_ENDPOINTS = [LCD_BASE_URL, ...RATE_LIMIT_LCD_FALLBACKS];

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
    // Short enough that a slow-but-alive endpoint can't burn the cron's whole
    // time budget across ~8 pages before the failover chain gets its turn.
    signal: AbortSignal.timeout(12_000),
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
  // A surviving next_key means the page cap cut the dump short. Returning it
  // would violate the "a partial dump is never returned" contract below —
  // downstream, missing paths read as recovered limits and trigger false
  // all-clear alerts — so refuse instead.
  if (nextKey) {
    throw new Error(
      "rate-limiter state dump exceeded the page cap; refusing a truncated dump"
    );
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

// Both assetlist projections from ONE fetch: denom -> symbol (readable
// alerts) and denom -> logo URI, SVG preferred (dashboard card decoration).
// Best-effort: a fetch failure degrades to empty maps (raw denoms / no logos),
// never a hard error. Display metadata only — deliberately not part of the
// stored snapshot payload.
export async function fetchAssetMaps(): Promise<{
  symbols: Map<string, string>;
  logos: Map<string, string>;
}> {
  const symbols = new Map<string, string>();
  const logos = new Map<string, string>();
  try {
    const data = await fetchJson<{
      assets: Array<{
        coinMinimalDenom?: string;
        symbol?: string;
        logoURIs?: { svg?: string; png?: string };
      }>;
    }>(ASSETLIST_URL);
    for (const asset of data.assets ?? []) {
      if (!asset.coinMinimalDenom) continue;
      if (asset.symbol) symbols.set(asset.coinMinimalDenom, asset.symbol);
      const logo = asset.logoURIs?.svg ?? asset.logoURIs?.png;
      if (logo) logos.set(asset.coinMinimalDenom, logo);
    }
  } catch (error) {
    logger.warn(
      "Assetlist fetch failed; alerts show raw denoms, card shows no logos:",
      error
    );
  }
  return { symbols, logos };
}

// Back-compat single-projection wrappers.
export async function fetchSymbolMap(): Promise<Map<string, string>> {
  return (await fetchAssetMaps()).symbols;
}
export async function fetchLogoMap(): Promise<Map<string, string>> {
  return (await fetchAssetMaps()).logos;
}
