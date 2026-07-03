import type { Metadata } from "next";
import { TreasuryView } from "@/components/treasury/TreasuryView";
import { SiteHeader } from "@/components/SiteHeader";

const TITLE = "OSMOscope: Treasury";
const DESCRIPTION =
  "The Osmosis community pool and associated DAO treasury: holdings, associated addresses, and liquidity positions, valued hourly.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/treasury" },
  // Inherits the root 1200x630 opengraph-image (app/opengraph-image.tsx).
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: "/treasury",
  },
  twitter: {
    card: "summary_large_image",
    site: "@osmosiszone",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function TreasuryPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <SiteHeader subtitle="Treasury" current="/treasury" />
        <TreasuryView />
      </div>
    </main>
  );
}
