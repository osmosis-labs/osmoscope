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

// A fresh latest block, for the fallback freshness check.
const freshBlock = () =>
  new Response(
    JSON.stringify({
      block: { header: { height: "1", time: new Date().toISOString() } },
    }),
    { headers: { "content-type": "application/json" }, status: 200 }
  );

test("fetchRateLimitPaths: refuses an empty decoded dump", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) =>
    String(input).includes("/blocks/latest")
      ? freshBlock()
      : new Response(
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
            headers: {
              "content-type": "application/json",
              "grpc-metadata-x-cosmos-block-height": "1",
            },
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

test("fetchRateLimitPaths: skips a fallback whose latest block is old", async () => {
  const limit: ContractRateLimit = {
    quota: {
      name: "DAY",
      max_percentage_send: 10,
      max_percentage_recv: 10,
      duration: 86_400,
      channel_value: "1000",
    },
    flow: { inflow: "0", outflow: "0", period_end: "9999999999999999999" },
  };
  const dump = (servedHeight = "1000") =>
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
        headers: {
          "content-type": "application/json",
          "grpc-metadata-x-cosmos-block-height": servedHeight,
        },
        status: 200,
      }
    );
  const originalFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    // The primary is down; the first fallback lags by an hour; the second is current.
    if (url.startsWith("https://lcd.osmosis.zone")) {
      return new Response("down", { status: 503 });
    }
    if (url.includes("/blocks/latest")) {
      const lagging = url.startsWith("https://osmosis-rest.publicnode.com");
      return new Response(
        JSON.stringify({
          block: {
            header: {
              height: "1",
              time: new Date(
                Date.now() - (lagging ? 3_600_000 : 0)
              ).toISOString(),
            },
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    }
    return dump();
  };
  try {
    const result = await fetchRateLimitPaths();
    assert.equal(result.endpoint, "https://rest.cosmos.directory/osmosis");
    assert.ok(
      !asked.some(
        (u) =>
          u.startsWith("https://osmosis-rest.publicnode.com") &&
          u.includes("/contract/")
      ),
      "the lagging fallback's dump must not be read"
    );
    assert.ok(
      !asked.some(
        (u) =>
          u.startsWith("https://lcd.osmosis.zone") &&
          u.includes("/blocks/latest")
      ),
      "the primary is not asked for its height"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchRateLimitPaths: rejects a fallback whose pages lag its latest block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://lcd.osmosis.zone")) {
      return new Response("down", { status: 503 });
    }
    if (url.includes("/blocks/latest")) {
      return new Response(
        JSON.stringify({
          block: { header: { height: "5000", time: new Date().toISOString() } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // State pages answered by a backend 4,000 blocks behind.
    return new Response(JSON.stringify({ models: [], pagination: {} }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "grpc-metadata-x-cosmos-block-height": "1000",
      },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchRateLimitPaths(), /below 4990/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
