// Edge-layer helpers for worker.ts: the canonical cache key for API GETs and
// the security headers every response carries. Kept out of worker.ts because
// that file imports the OpenNext build output and cannot be unit-tested.

// The largest page /api/history serves; the whole table is about 2,000 rows,
// and the default (no `page`) already returns all of it.
export const HISTORY_PAGE_SIZE_MAX = 500;
const HISTORY_PAGE_SIZE_DEFAULT = 100;

export type HistoryQuery =
  | { kind: "all"; order: "asc" | "desc" | null }
  | { kind: "page"; page: number; pageSize: number; order: "asc" | "desc" }
  | { kind: "invalid"; reason: string };

const POSITIVE_INT = /^[1-9]\d{0,5}$/;

// The /api/history query parameters, validated. `limit` and `order` are the
// accepted aliases of `pageSize` and `orderBy`. Shared by the route and by the
// cache key so the two can never disagree about what a request means.
export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  const rawOrder = (
    params.get("orderBy") ?? params.get("order")
  )?.toLowerCase();
  if (rawOrder != null && rawOrder !== "asc" && rawOrder !== "desc") {
    return { kind: "invalid", reason: "orderBy must be asc or desc" };
  }
  const order = (rawOrder ?? null) as "asc" | "desc" | null;

  const rawPage = params.get("page");
  if (rawPage == null) return { kind: "all", order };
  if (!POSITIVE_INT.test(rawPage)) {
    return { kind: "invalid", reason: "page must be a positive integer" };
  }

  const rawSize = params.get("pageSize") ?? params.get("limit");
  if (rawSize != null && !POSITIVE_INT.test(rawSize)) {
    return { kind: "invalid", reason: "pageSize must be a positive integer" };
  }
  const pageSize =
    rawSize == null ? HISTORY_PAGE_SIZE_DEFAULT : Number(rawSize);
  if (pageSize > HISTORY_PAGE_SIZE_MAX) {
    return {
      kind: "invalid",
      reason: `pageSize must be at most ${HISTORY_PAGE_SIZE_MAX}`,
    };
  }
  return {
    kind: "page",
    page: Number(rawPage),
    pageSize,
    order: order ?? "desc",
  };
}

// The URL an API GET is cached under. Only /api/history reads query
// parameters; every other route ignores them, so they are dropped and any
// query string maps to the one cached copy. History parameters are reduced to
// one canonical spelling. Returns null for a request the route will reject
// (it answers 400, which is never cached), so it is looked up as sent.
export function canonicalApiUrl(url: URL): URL | null {
  const key = new URL(url.origin + url.pathname);
  if (url.pathname !== "/api/history") return key;

  const query = parseHistoryQuery(url.searchParams);
  if (query.kind === "invalid") return null;
  if (query.kind === "page") {
    key.searchParams.set("page", String(query.page));
    key.searchParams.set("pageSize", String(query.pageSize));
    key.searchParams.set("orderBy", query.order);
  } else if (query.order) {
    key.searchParams.set("orderBy", query.order);
  }
  return key;
}

// Sent on every response. The site has no forms or wallet actions; these
// contain a future rendering bug and keep the pages out of frames.
//
// script-src keeps 'unsafe-inline' because the prerendered pages carry
// Next.js inline bootstrap scripts; a nonce would force every page to render
// per request. img-src and connect-src allow any https host because asset
// logos come from assetlist-supplied URLs and the screenshot export fetches
// them to draw the PNG.
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

// A copy of the response with the security headers set (response headers
// from the cache or the app can be immutable, so they are not edited in place).
export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  return out;
}
