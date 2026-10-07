// Canonical base URL for the site, shared by metadata (layout), robots, and
// sitemap so they never drift. Set NEXT_PUBLIC_SITE_URL to the production
// domain; falls back to localhost for dev.
// (Kept out of app/layout.tsx because Next only allows an allowlisted set of
// exports from route/layout modules — an extra `export const` fails the build.)
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
