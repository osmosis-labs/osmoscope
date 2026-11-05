import type { Metadata } from "next";
import { preload } from "react-dom";
import { StakingView } from "@/components/staking/StakingView";
import { SiteHeader } from "@/components/SiteHeader";

const TITLE = "OSMOscope: Network";
const DESCRIPTION =
  "Osmosis network health and decentralization: the Nakamoto and Gini coefficients, voting-power distribution, the validator set, pending undelegations, block rate, and validator performance.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/network" },
  // Inherits the root 1200x630 opengraph-image (app/opengraph-image.tsx).
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: "/network",
  },
  twitter: {
    card: "summary_large_image",
    site: "@osmosiszone",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// The small payloads the top of the page (KPI strip, leaderboard, treemap)
// needs. Preloading starts them with the HTML instead of after the page's
// JavaScript has downloaded and run; the hooks' fetch() calls then reuse the
// responses (same URLs, same-origin credentials, so the browser matches them).
// /api/history (~230 KB) is left out on purpose: only the charts further down
// use it, and preloading it competes with the JavaScript on slow connections.
const PRELOAD = [
  "/api/validators",
  "/api/undelegations",
  "/api/osmosis-metrics",
];

export default function StakingPage() {
  for (const href of PRELOAD)
    preload(href, { as: "fetch", crossOrigin: "anonymous" });
  return (
    <main className="min-h-screen overflow-x-hidden bg-linear-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <SiteHeader subtitle="Network" current="/network" />
        <StakingView />
      </div>
    </main>
  );
}
