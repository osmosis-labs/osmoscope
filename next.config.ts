import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactStrictMode: true,
  poweredByHeader: false,
  // Left unbundled so each host resolves Prisma's own entry: Node's for scripts and local dev,
  // and on Cloudflare (OpenNext bundles with Workers conditions) the one that
  // imports the query compiler's Wasm as a module. Workers forbid compiling
  // Wasm at runtime, which the Node entry does.
  // The pg driver adapter is left unbundled for the same reason: pg reaches
  // its Workers socket through pg-cloudflare, whose real export sits behind
  // the `workerd` condition. Bundled by Next's server build (which Next 16
  // does when pg is only reached through the adapter), it resolves to the
  // empty default and every query fails on Workers.
  serverExternalPackages: [
    "@prisma/client",
    ".prisma/client",
    "@prisma/adapter-pg",
    "pg",
  ],
  // The package names above don't cover this subpath (lib/database.ts).
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals.push({
        ".prisma/client/edge": "commonjs .prisma/client/edge",
      });
    }
    return config;
  },
  async redirects() {
    return [
      // The Network page moved from /staking to /network; keep old links working.
      { source: "/staking", destination: "/network", permanent: true },
    ];
  },
};

export default nextConfig;
