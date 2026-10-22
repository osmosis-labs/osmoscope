// The edge cache key must collapse every spelling of a request onto one
// cached copy: an unread query parameter forcing a miss is what let
// cache-busted requests drive database reads and LCD fan-outs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalApiUrl,
  HISTORY_PAGE_SIZE_MAX,
  parseHistoryQuery,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from "./edge";

const key = (path: string) =>
  canonicalApiUrl(new URL(`https://osmoscope.osmosis.zone${path}`))?.toString();

test("routes that read no params drop every query string", () => {
  for (const route of [
    "/api/validators",
    "/api/treasury",
    "/api/rate-limits",
  ]) {
    assert.equal(key(`${route}?x=1`), `https://osmoscope.osmosis.zone${route}`);
    assert.equal(key(`${route}?a=1&b=2`), key(route));
  }
});

test("history without page keeps only a valid order", () => {
  assert.equal(key("/api/history?bust=123"), key("/api/history"));
  assert.equal(key("/api/history?order=ASC"), key("/api/history?orderBy=asc"));
  assert.notEqual(key("/api/history?orderBy=asc"), key("/api/history"));
});

test("history pages map aliases and defaults onto one key", () => {
  const canonical = key("/api/history?page=2&pageSize=100&orderBy=desc");
  assert.equal(key("/api/history?page=2"), canonical);
  assert.equal(key("/api/history?limit=100&page=2&junk=1"), canonical);
});

test("history rejects bad params, and those are not normalised", () => {
  for (const q of [
    "page=0",
    "page=abc",
    "page=1&pageSize=abc",
    `page=1&pageSize=${HISTORY_PAGE_SIZE_MAX + 1}`,
    "orderBy=sideways",
  ]) {
    assert.equal(parseHistoryQuery(new URLSearchParams(q)).kind, "invalid", q);
    assert.equal(key(`/api/history?${q}`), undefined, q);
  }
});

test("security headers are added without dropping the response's own", async () => {
  const original = new Response("ok", {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
  const out = withSecurityHeaders(original);
  assert.equal(out.status, 201);
  assert.equal(out.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(out.headers.get(name), value);
  }
  assert.match(
    out.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/
  );
  assert.equal(await out.text(), "ok");
});
