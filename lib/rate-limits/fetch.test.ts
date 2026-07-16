import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFlowKey,
  fetchRateLimitPaths,
  type ContractRateLimit,
} from "./fetch";

function lenPrefix(bytes: Buffer): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(bytes.length);
  return out;
}

function flowKeyHex(channel: string, denom: string): string {
  const namespace = Buffer.from("flow");
  const channelBytes = Buffer.from(channel);
  return Buffer.concat([
    lenPrefix(namespace),
    namespace,
    lenPrefix(channelBytes),
    channelBytes,
    Buffer.from(denom),
  ]).toString("hex");
}

test("decodeFlowKey: parses hex cw-storage-plus flow keys", () => {
  assert.deepEqual(decodeFlowKey(flowKeyHex("any", "uosmo")), {
    channel: "any",
    denom: "uosmo",
  });
});

test("fetchRateLimitPaths: refuses an empty decoded dump", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        models: [
          {
            key: flowKeyHex("any", "uosmo"),
            value: Buffer.from(JSON.stringify([])).toString("base64"),
          },
        ],
        pagination: {},
      }),
      {
        headers: { "content-type": "application/json" },
        status: 200,
      }
    );

  try {
    await assert.rejects(() => fetchRateLimitPaths(), /decoded no flow paths/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchRateLimitPaths: returns decoded flow paths", async () => {
  const limit: ContractRateLimit = {
    quota: {
      name: "DAY",
      max_percentage_send: 10,
      max_percentage_recv: 10,
      duration: 86_400,
      channel_value: "1000",
    },
    flow: {
      inflow: "0",
      outflow: "0",
      period_end: "9999999999999999999",
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        models: [
          {
            key: flowKeyHex("any", "uosmo"),
            value: Buffer.from(JSON.stringify([limit])).toString("base64"),
          },
        ],
        pagination: {},
      }),
      {
        headers: { "content-type": "application/json" },
        status: 200,
      }
    );

  try {
    const result = await fetchRateLimitPaths();
    assert.equal(result.endpoint, "https://lcd.osmosis.zone");
    assert.deepEqual(result.paths, [
      {
        channel: "any",
        denom: "uosmo",
        limits: [limit],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
