import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      // The Network page moved from /staking to /network; keep old links working.
      { source: "/staking", destination: "/network", permanent: true },
    ];
  },
};

export default nextConfig;
