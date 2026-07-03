import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Allow indexing only on the production deployment. Preview/branch deploys on
// Vercel set VERCEL_ENV to "preview"/"development" — we disallow those so a
// throwaway deployment URL can't get crawled and outrank the canonical domain.
// VERCEL_ENV is unset in local dev, which also disallows (correct).
export default function robots(): MetadataRoute.Robots {
  const isProduction = process.env.VERCEL_ENV === "production";

  if (!isProduction) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
