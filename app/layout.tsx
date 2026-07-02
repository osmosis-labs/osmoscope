import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"] });

const TITLE = "OSMOscope: Tokenomics";
const DESCRIPTION =
  "Live OSMO supply, inflation, burn, staking and protocol-revenue metrics for the Osmosis chain.";

// Base URL for resolving OG/Twitter image + canonical URLs. Set
// NEXT_PUBLIC_SITE_URL to the production domain; falls back to the Vercel
// deployment URL, then localhost for dev. Without this, root-relative image
// paths resolve against localhost in some build contexts (the build warning).
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
  "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // opengraph-image.tsx (1200x630) is picked up automatically for OG + Twitter;
  // no explicit `images` needed. Large card so shared links show a real preview.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
