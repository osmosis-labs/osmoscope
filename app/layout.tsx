import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "OSMO Tokenomics Dashboard",
  description:
    "Live OSMO supply, inflation, burn, staking and protocol-revenue metrics for the Osmosis chain.",
  openGraph: {
    title: "OSMO Tokenomics Dashboard",
    description:
      "Live OSMO supply, inflation, burn, staking and protocol-revenue metrics for the Osmosis chain.",
    type: "website",
    images: ["/Osmosis_Icon.png"],
  },
  twitter: {
    card: "summary",
    title: "OSMO Tokenomics Dashboard",
    description:
      "Live OSMO supply, inflation, burn, staking and protocol-revenue metrics for the Osmosis chain.",
    images: ["/Osmosis_Icon.png"],
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
