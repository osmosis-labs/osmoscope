import type { Metadata } from "next";
import Link from "next/link";
import { TreasuryView } from "@/components/treasury/TreasuryView";

const TITLE = "OSMOscope: Treasury";
const DESCRIPTION =
  "The Osmosis community pool and associated DAO treasury: holdings, associated addresses, and liquidity positions, valued live.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    images: ["/Osmosis_Icon.png"],
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/Osmosis_Icon.png"],
  },
};

export default function TreasuryPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-osmo-900 via-osmo-800 to-osmo-900 p-4 sm:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 mt-2 flex items-center justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-3 sm:gap-4">
            <img
              src="/Osmosis_Icon.png"
              alt="OSMOscope logo"
              className="h-12 w-12 shrink-0 sm:h-16 sm:w-16"
            />
            <div>
              <h1 className="text-2xl font-bold leading-tight text-white sm:text-4xl">
                OSMOscope
              </h1>
              <p className="text-sm text-osmo-200 sm:text-base">Treasury</p>
            </div>
          </div>
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
          >
            Tokenomics
          </Link>
        </header>

        <TreasuryView />
      </div>
    </main>
  );
}
