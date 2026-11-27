import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "./async";

test("mapLimit: preserves input order and respects concurrency cap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [30, 10, 20, 5, 15, 25];
  const out = await mapLimit(items, 2, async (ms, index) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return `${index}:${ms}`;
  });
  assert.deepEqual(out, ["0:30", "1:10", "2:20", "3:5", "4:15", "5:25"]);
  assert.ok(maxInFlight <= 2, `expected maxInFlight <= 2, got ${maxInFlight}`);
});

test("mapLimit: handles empty arrays", async () => {
  const out = await mapLimit([], 4, async (x) => x);
  assert.deepEqual(out, []);
});
