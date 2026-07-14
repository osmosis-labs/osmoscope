import type { Metadata } from "next";
import { StakingView } from "@/components/staking/StakingView";
import { SiteHeader } from "@/components/SiteHeader";

const TITLE = "OSMOscope: Network";
const DESCRIPTION =
  "Osmosis network health and decentralization: the Nakamoto and Gini coefficients, voting-power distribution, the validator set, pending undelegations, block rate, and validator performance.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/staking" },
  // Inherits the root 1200x630 opengraph-image (app/opengraph-image.tsx).
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: "/staking",
  },
  twitter: {
    card: "summary_large_image",
    site: "@osmosiszone",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function StakingPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <SiteHeader subtitle="Network" current="/staking" />
        <StakingView />
      </div>
    </main>
  );
}
