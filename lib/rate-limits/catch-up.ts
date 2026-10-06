// Fills hours of rate-limit readings the cron missed. Scheduled runs start
// late or not at all, so an hour can pass with no run; its readings are
// rebuilt from the contract's state at a block in that hour (the historical
// LCD endpoints keep weeks of recent state). Past hours are data only: they
// never drive alerts, which are judged on the live state.
import { logger } from "../logger";
import { HISTORICAL_LCD_ENDPOINTS } from "./fetch";
import { buildRateLimitSnapshot } from "./snapshot";
import { readingHoursSince, saveRateLimitSnapshot } from "./store";

const HOUR_MS = 60 * 60 * 1000;

// How far back a run looks, and how many hours it fills at most, so a long
// outage can't hold up a run; later runs take the rest.
export const CATCH_UP_HOURS = 48;
export const MAX_FILLS_PER_RUN = 6;

// Pure: hour starts (ms, newest first) in the last `maxHours` complete hours
// before `nowMs` with no readings. The current hour is the live run's job.
export function missingReadingHours(
  present: Set<number>,
  nowMs: number,
  maxHours = CATCH_UP_HOURS
): number[] {
  const current = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const missing: number[] = [];
  for (let i = 1; i <= maxHours; i++) {
    const hour = current - i * HOUR_MS;
    if (!present.has(hour)) missing.push(hour);
  }
  return missing;
}

interface Block {
  height: number;
  timeMs: number;
}

async function fetchBlock(path: string): Promise<Block> {
  let lastError: unknown = null;
  for (const endpoint of HISTORICAL_LCD_ENDPOINTS) {
    try {
      const response = await fetch(
        `${endpoint}/cosmos/base/tendermint/v1beta1/blocks/${path}`,
        { signal: AbortSignal.timeout(12_000) }
      );
      if (!response.ok) throw new Error(`${response.status} for ${path}`);
      const data = (await response.json()) as {
        block: { header: { height: string; time: string } };
      };
      return {
        height: Number(data.block.header.height),
        timeMs: Date.parse(data.block.header.time),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`block ${path} unavailable: ${String(lastError)}`);
}

// A block inside the hour starting at `hour`: aims two minutes in (block
// times vary, so a few interpolation steps from the tip) and accepts any
// block in the hour's first ten minutes.
export async function blockInHour(hour: number, tip: Block): Promise<Block> {
  const target = hour + 2 * 60_000;
  let known = tip;
  let msPerBlock = 1300;
  for (let i = 0; i < 6; i++) {
    const guess = Math.round(
      known.height - (known.timeMs - target) / msPerBlock
    );
    const block = await fetchBlock(String(guess));
    if (block.timeMs >= hour && block.timeMs < hour + 10 * 60_000) {
      return block;
    }
    if (block.height !== known.height) {
      msPerBlock = Math.max(
        200,
        Math.abs((known.timeMs - block.timeMs) / (known.height - block.height))
      );
    }
    known = block;
  }
  throw new Error(`no block found in the hour ${new Date(hour).toISOString()}`);
}

// Rebuilds and stores up to MAX_FILLS_PER_RUN missing hours. Non-fatal per
// hour: a failure leaves that hour to a later run.
export async function catchUpReadings(nowMs = Date.now()): Promise<{
  filled: number;
  missing: number;
  errors: string[];
}> {
  const present = await readingHoursSince(
    new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS - CATCH_UP_HOURS * HOUR_MS)
  );
  const missing = missingReadingHours(present, nowMs);
  const errors: string[] = [];
  let filled = 0;
  if (missing.length === 0) return { filled, missing: 0, errors };

  const tip = await fetchBlock("latest");
  for (const hour of missing.slice(0, MAX_FILLS_PER_RUN)) {
    try {
      const block = await blockInHour(hour, tip);
      const snapshot = await buildRateLimitSnapshot(block);
      await saveRateLimitSnapshot(snapshot);
      filled++;
    } catch (error) {
      const message = `${new Date(hour).toISOString()}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.warn(`Rate-limit catch-up failed for ${message}`);
      errors.push(message);
    }
  }
  return { filled, missing: missing.length, errors };
}
