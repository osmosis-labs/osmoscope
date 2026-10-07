import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Allow indexing only on the production deployment AND only once a canonical
// domain is configured (NEXT_PUBLIC_SITE_URL). Requiring the explicit domain
// (not just SITE_ENV) means: preview/dev deploys stay disallowed, and a
// production build served only from the auto-assigned *.workers.dev URL also
// stays un-indexed until the real domain is set. Set NEXT_PUBLIC_SITE_URL to
// the canonical domain to flip indexing on.
export default function robots(): MetadataRoute.Robots {
  // SITE_ENV is set in wrangler.jsonc and overridden for preview builds.
  const isProduction = process.env.SITE_ENV === "production";
  const hasCanonicalDomain = !!process.env.NEXT_PUBLIC_SITE_URL;

  if (!isProduction || !hasCanonicalDomain) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
