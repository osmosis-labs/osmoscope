import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// The two public routes. Data updates continuously (hourly treasury, daily
// supply snapshots), so both are marked as frequently changing.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${SITE_URL}/treasury`,
      changeFrequency: "hourly",
      priority: 0.8,
    },
  ];
}
