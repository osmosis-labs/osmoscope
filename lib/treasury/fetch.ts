// Low-level fetch helpers for the treasury engine: LCD JSON (with retry +
// fallback), CosmWasm smart queries, and EVM JSON-RPC (native + ERC20 balances).
// Ported from the community-pool Apps Script; server-only (used by the cron/
// snapshot builder, never the client).
import { logger } from "../logger";
import {
  EVM_RPC_ENDPOINTS,
  SOLANA_RPC_ENDPOINTS,
} from "@/config/community-pool";

// NOTE: lcd.osmosis.zone blocks CosmWasm smart queries (and 403s some other
// paths), so it must NOT be relied on alone and a 403/blocked response has to
// fall through to the next base rather than abort. Polkachu serves everything
// (including CosmWasm) reliably, so it leads. An env override, if set, is tried
// first for local/prod flexibility.
const LCD_BASES = [
  ...(process.env.NEXT_PUBLIC_LCD_BASE_URL
    ? [process.env.NEXT_PUBLIC_LCD_BASE_URL]
    : []),
  "https://osmosis-api.polkachu.com",
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
  "https://lcd.osmosis.zone",
];

// CosmWasm smart queries are only served by some providers (NOT lcd.osmosis.zone,
// which blocks them). Multiple bases so a single endpoint rate-limiting mid-run
// doesn't silently zero out a holding.
const COSMWASM_BASES = [
  "https://osmosis-api.polkachu.com",
  "https://osmosis-rest.publicnode.com",
  "https://rest.cosmos.directory/osmosis",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Per-request timeout across LCD, CosmWasm, and RPC calls so one hung node
// fails over to the next endpoint instead of stalling the hourly cron.
const FETCH_TIMEOUT_MS = 15_000;

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
        const resp = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.ok) return (await resp.json()) as T;
        await resp.body?.cancel().catch(() => {});
        // Retry/fall back on 5xx (transient) and on 401/403/429: lcd.osmosis.zone
        // BLOCKS some paths with 403 and rate-limits with 429, but another base
        // serves them fine — so these must fall through, never abort the snapshot.
        // Only a 404 (genuinely absent) breaks out of this base early.
        const retryable =
          (resp.status >= 500 && resp.status < 600) ||
          resp.status === 401 ||
          resp.status === 403 ||
          resp.status === 429;
        lastError = new Error(`HTTP ${resp.status} from ${url}`);
        if (retryable) continue;
        break; // e.g. 404 — try the next base rather than retrying this one
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
  const initialBackoffMs = 400;
  let lastError: Error | null = null;

  for (const rawBase of COSMWASM_BASES) {
    const base = rawBase.replace(/\/+$/, "");
    // Rate-limit (429/403) is worth a few patient retries under our concurrent
    // burst; a 5xx rarely self-heals within a run, so give it only ONE quick
    // retry before falling to the next base. At least one vault contract
    // (locust-vault-2285) 5xxs on ALL bases every time — with 4 retries/base and
    // 1s+ exponential backoff that one vault alone burned ~21s per snapshot.
    let attempt = 0;
    for (;;) {
      if (attempt > 0) await sleep(initialBackoffMs * 2 ** (attempt - 1));
      try {
        const resp = await fetch(base + path, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.ok) {
          const body = (await resp.json()) as { data?: T };
          return body?.data ?? null;
        }
        await resp.body?.cancel().catch(() => {});
        lastError = new Error(`HTTP ${resp.status} from ${base + path}`);
        const isRateLimit = resp.status === 429 || resp.status === 403;
        const is5xx = resp.status >= 500 && resp.status < 600;
        const maxAttempts = isRateLimit ? 4 : is5xx ? 2 : 1;
        attempt++;
        if (attempt < maxAttempts) continue; // retry same base
        break; // give up on this base, fall to the next
      } catch (e) {
        lastError = e as Error;
        attempt++;
        if (attempt < 2) continue; // one network retry, then next base
        break;
      }
    }
  }
  logger.warn(
    `CosmWasm query failed for ${contractAddress}: ${lastError?.message ?? "unknown"}`
  );
  return null;
}

// --- Shared JSON-RPC failover (EVM + Solana) -------------------------------

// Strip query strings / paths from logged RPC URLs so keyed provider URLs
// never leak credentials into logs or error messages.
function endpointLabel(endpoint: string, chainLabel: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return `<invalid ${chainLabel} RPC URL>`;
  }
}

async function fetchJsonRpc<T>(
  endpoints: string[],
  chainLabel: string,
  method: string,
  params: unknown[],
  requireResult: boolean
): Promise<T | undefined> {
  const payload = { jsonrpc: "2.0", id: 1, method, params };
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    const label = endpointLabel(endpoint, chainLabel);
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        lastError = new Error(`HTTP ${resp.status} from ${label}`);
        continue;
      }
      const data = (await resp.json()) as { result?: T; error?: unknown };
      if (data.error) {
        lastError = new Error(`RPC error: ${JSON.stringify(data.error)}`);
        continue;
      }
      if (requireResult && data.result === undefined) {
        lastError = new Error(`Empty result from ${label}`);
        continue;
      }
      return data.result;
    } catch (e) {
      lastError = e as Error;
      logger.warn(
        `${chainLabel} RPC ${method} at ${label}: ${lastError.message}`
      );
    }
  }
  throw new Error(
    `All ${chainLabel} RPC endpoints failed for ${method}. Last: ${lastError?.message ?? "unknown"}`
  );
}

// --- EVM (Ethereum mainnet) JSON-RPC ---------------------------------------

async function fetchEvmRpc(
  chainId: string,
  method: string,
  params: unknown[]
): Promise<string> {
  const endpoints = EVM_RPC_ENDPOINTS[chainId];
  if (!endpoints?.length) {
    throw new Error(`No EVM RPC endpoints for chainId ${chainId}`);
  }
  const result = await fetchJsonRpc<string>(
    endpoints,
    "EVM",
    method,
    params,
    false
  );
  return result ?? "0x";
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

// ---------------------------------------------------------------------------
// Solana (mainnet-beta) JSON-RPC. Different API from EVM: getBalance returns
// lamports (native SOL), getTokenAccountsByOwner returns SPL token accounts.
// Rotates endpoints on failure like the EVM path.
// ---------------------------------------------------------------------------

async function fetchSolanaRpc<T>(
  method: string,
  params: unknown[]
): Promise<T> {
  const endpoints = SOLANA_RPC_ENDPOINTS;
  if (!endpoints?.length) throw new Error("No Solana RPC endpoints configured");
  return (await fetchJsonRpc<T>(
    endpoints,
    "Solana",
    method,
    params,
    true
  )) as T;
}

// Native SOL balance (lamports → SOL). getBalance returns { value: lamports }.
export async function fetchSolanaNativeBalance(
  address: string,
  decimals: number
): Promise<number> {
  const res = await fetchSolanaRpc<{ value: number }>("getBalance", [address]);
  const lamports = res?.value ?? 0;
  return lamports / 10 ** decimals;
}

// SPL token balance for a specific mint held by `owner`. Sums across all of the
// owner's token accounts for that mint (usually one) using the parsed uiAmount.
export async function fetchSolanaSplBalance(
  owner: string,
  mint: string
): Promise<number> {
  const res = await fetchSolanaRpc<{
    value: Array<{
      account: {
        data: {
          parsed: { info: { tokenAmount: { uiAmount: number | null } } };
        };
      };
    }>;
  }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  const accounts = res?.value ?? [];
  return accounts.reduce((sum, a) => {
    const ui = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
    return sum + (typeof ui === "number" ? ui : 0);
  }, 0);
}
