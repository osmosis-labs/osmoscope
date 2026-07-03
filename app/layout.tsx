import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SITE_URL } from "@/lib/site";

const inter = Inter({ subsets: ["latin"] });

const TITLE = "OSMOscope: Tokenomics";
const DESCRIPTION =
  "Live OSMO supply, inflation, burn, staking and protocol-revenue metrics for the Osmosis chain.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  // opengraph-image.tsx (1200x630) is picked up automatically for OG + Twitter;
  // no explicit `images` needed. Large card so shared links show a real preview.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    site: "@osmosiszone",
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
