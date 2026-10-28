// Shared fetch layer for the Numia public API. Numia intermittently answers
// 5xx (observed: /tokens/v2/all HTTP 500 failing whole treasury cron runs), so
// every Numia call goes through numiaFetch: bearer auth when a key is set, a
// per-attempt timeout, and backoff retries on 5xx / 429 / network errors.
// Other 4xx are returned as-is (a bad request won't improve on retry), and the
// final response or error is handed back to the caller, which keeps its own
// policy for an outage (throw, or leave the value unknown). Never a stale or
// zero substitute here.
import { logger } from "./logger";

export const NUMIA_API_URL =
  process.env.NUMIA_API_URL || "https://public-osmosis-api.numia.xyz";
const NUMIA_API_KEY = process.env.NUMIA_API_KEY;

export interface NumiaFetchOptions {
  attempts?: number; // total tries, including the first
  baseDelayMs?: number; // backoff before retry n is baseDelayMs * 3^(n-1)
  timeoutMs?: number; // bounds each ATTEMPT, not the whole loop
  // Injectable for tests.
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

// GET `${NUMIA_API_URL}${path}`. Resolves with the last Response (ok or not)
// once it is non-retryable or attempts run out; rejects only if the final
// attempt itself threw (network error / timeout).
export async function numiaFetch(
  path: string,
  options: NumiaFetchOptions = {}
): Promise<Response> {
  const {
    attempts = 3,
    baseDelayMs = 2000,
    timeoutMs = 30_000,
    fetchFn = fetch,
    sleep = defaultSleep,
  } = options;
  const headers: HeadersInit = { Accept: "application/json" };
  if (NUMIA_API_KEY) headers.Authorization = `Bearer ${NUMIA_API_KEY}`;

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    let failure: string;
    try {
      const resp = await fetchFn(`${NUMIA_API_URL}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (last || !retryable(resp.status)) return resp;
      failure = `HTTP ${resp.status}`;
      // Free the connection before retrying.
      await resp.body?.cancel().catch(() => {});
    } catch (error) {
      if (last) throw error;
      failure = (error as Error).message;
    }
    const wait = baseDelayMs * 3 ** (attempt - 1);
    logger.warn(
      `Numia ${path} ${failure}; retrying in ${wait}ms (attempt ${attempt}/${attempts})`
    );
    await sleep(wait);
  }
}
