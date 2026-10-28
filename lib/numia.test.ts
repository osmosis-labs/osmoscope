// numiaFetch retries only what can recover (5xx, 429, network errors) and hands
// the final answer back unchanged, so callers keep their own outage policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { numiaFetch } from "./numia";

function scripted(steps: (number | Error)[]) {
  let calls = 0;
  const fetchFn = (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return new Response("[]", { status: step });
  }) as typeof fetch;
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { fetchFn, sleep, waits, calls: () => calls };
}

test("retries a 500 and returns the recovered response", async () => {
  const s = scripted([500, 503, 200]);
  const resp = await numiaFetch("/tokens/v2/all", { ...s, baseDelayMs: 10 });
  assert.equal(resp.status, 200);
  assert.equal(s.calls(), 3);
  assert.deepEqual(s.waits, [10, 30]);
});

test("returns the last 5xx once attempts run out", async () => {
  const s = scripted([500]);
  const resp = await numiaFetch("/tokens/v2/all", { ...s, attempts: 3 });
  assert.equal(resp.status, 500);
  assert.equal(s.calls(), 3);
});

test("retries 429 but not other 4xx", async () => {
  const limited = scripted([429, 200]);
  assert.equal((await numiaFetch("/apr", limited)).status, 200);
  assert.equal(limited.calls(), 2);

  const bad = scripted([404, 200]);
  assert.equal((await numiaFetch("/apr", bad)).status, 404);
  assert.equal(bad.calls(), 1);
});

test("retries network errors and rethrows the final one", async () => {
  const flaky = scripted([new Error("ECONNRESET"), 200]);
  assert.equal((await numiaFetch("/apr", flaky)).status, 200);

  const down = scripted([new Error("ECONNRESET")]);
  await assert.rejects(numiaFetch("/apr", { ...down, attempts: 2 }), {
    message: "ECONNRESET",
  });
  assert.equal(down.calls(), 2);
});
