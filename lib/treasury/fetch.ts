// Low-level fetch helpers for the treasury engine: LCD JSON (with retry +
// fallback), CosmWasm smart queries, and EVM JSON-RPC (native + ERC20 balances).
// Ported from the community-pool Apps Script; server-only (used by the cron/
// snapshot builder, never the client).
import { logger } from "../logger";
import { EVM_RPC_ENDPOINTS } from "@/config/community-pool";

const LCD_BASES = [
  process.env.NEXT_PUBLIC_LCD_BASE_URL || "https://lcd.osmosis.zone",
  "https://osmosis-api.polkachu.com",
];

// CosmWasm smart queries are only served by some providers. Multiple bases so a
// single endpoint rate-limiting mid-run doesn't silently zero out a holding.
const COSMWASM_BASES = [
  "https://osmosis-api.polkachu.com",
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch JSON from an Osmosis LCD with retries per base and fallback across bases.
export async function fetchLcdJson<T = unknown>(path: string): Promise<T> {
  const maxRetriesPerBase = 3;
  const initialBackoffMs = 500;
  let lastError: Error | null = null;

  for (const rawBase of LCD_BASES) {
    const base = rawBase.replace(/\/+$/, "");
    for (let attempt = 0; attempt < maxRetriesPerBase; attempt++) {
      if (attempt > 0) await sleep(initialBackoffMs * 2 ** (attempt - 1));
      const url = base + (path.startsWith("/") ? path : "/" + path);
      try {
        const resp = await fetch(url);
        if (resp.ok) return (await resp.json()) as T;
        // 5xx: transient — retry / fall back. 4xx: hard failure, stop.
        if (resp.status >= 500 && resp.status < 600) {
          lastError = new Error(`HTTP ${resp.status} from ${url}`);
          continue;
        }
        throw new Error(`Non-retryable HTTP ${resp.status} from ${url}`);
      } catch (e) {
        lastError = e as Error;
        logger.warn(`LCD ${url} attempt ${attempt + 1}: ${lastError.message}`);
      }
    }
  }
  throw new Error(
    `All LCD endpoints failed. Last error: ${lastError?.message ?? "unknown"}`
  );
}

// --- CosmWasm smart queries ------------------------------------------------

function encodeSmartQuery(queryObj: unknown): string {
  const json = JSON.stringify(queryObj);
  return encodeURIComponent(Buffer.from(json, "utf-8").toString("base64"));
}

// Returns the `data` payload of a CosmWasm smart query, or null on failure.
export async function fetchCosmwasmSmartData<T = unknown>(
  contractAddress: string,
  queryObj: unknown
): Promise<T | null> {
  const encoded = encodeSmartQuery(queryObj);
  const path = `/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${encoded}`;
  const maxRetriesPerBase = 4;
  const initialBackoffMs = 1000;
  let lastError: Error | null = null;

  for (const rawBase of COSMWASM_BASES) {
    const base = rawBase.replace(/\/+$/, "");
    for (let attempt = 0; attempt < maxRetriesPerBase; attempt++) {
      if (attempt > 0) await sleep(initialBackoffMs * 2 ** (attempt - 1));
      try {
        const resp = await fetch(base + path);
        if (resp.ok) {
          const body = (await resp.json()) as { data?: T };
          return body?.data ?? null;
        }
        if (resp.status >= 400 && resp.status < 500) break; // hard failure
        lastError = new Error(`HTTP ${resp.status} from ${base + path}`);
      } catch (e) {
        lastError = e as Error;
      }
    }
  }
  logger.warn(
    `CosmWasm query failed for ${contractAddress}: ${lastError?.message ?? "unknown"}`
  );
  return null;
}

// --- EVM (Ethereum mainnet) JSON-RPC ---------------------------------------

export function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

async function fetchEvmRpc(
  chainId: string,
  method: string,
  params: unknown[]
): Promise<string> {
  const endpoints = EVM_RPC_ENDPOINTS[chainId];
  if (!endpoints?.length) {
    throw new Error(`No EVM RPC endpoints for chainId ${chainId}`);
  }
  const payload = { jsonrpc: "2.0", id: 1, method, params };
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status} from ${endpoint}`);
        continue;
      }
      const data = (await resp.json()) as {
        result?: string;
        error?: unknown;
      };
      if (data.error) {
        lastError = new Error(`RPC error: ${JSON.stringify(data.error)}`);
        continue;
      }
      return data.result ?? "0x";
    } catch (e) {
      lastError = e as Error;
      logger.warn(`EVM RPC ${method} at ${endpoint}: ${lastError.message}`);
    }
  }
  throw new Error(
    `All EVM RPC endpoints failed for ${method}. Last: ${lastError?.message ?? "unknown"}`
  );
}

// Convert a hex quantity to a decimal number, scaled by `decimals`, using BigInt
// so large balances don't lose precision before the final Number() conversion.
function hexToDecimal(hex: string, decimals: number): number {
  if (!hex || hex === "0x") return 0;
  const raw = BigInt(hex);
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const fractionStr = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return Number(
    fractionStr ? `${whole.toString()}.${fractionStr}` : whole.toString()
  );
}

function encodeErc20BalanceOf(address: string): string {
  const selector = "70a08231"; // balanceOf(address)
  const clean = address.toLowerCase().replace(/^0x/, "");
  if (!/^[a-f0-9]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address for balanceOf: ${address}`);
  }
  return "0x" + selector + clean.padStart(64, "0");
}

export async function fetchEvmNativeBalance(
  chainId: string,
  address: string,
  decimals: number
): Promise<number> {
  const hex = await fetchEvmRpc(chainId, "eth_getBalance", [address, "latest"]);
  return hexToDecimal(hex, decimals);
}

export async function fetchErc20Balance(
  chainId: string,
  address: string,
  tokenContract: string,
  decimals: number
): Promise<number> {
  const hex = await fetchEvmRpc(chainId, "eth_call", [
    { to: tokenContract, data: encodeErc20BalanceOf(address) },
    "latest",
  ]);
  return hexToDecimal(hex, decimals);
}
