import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Marketing routes that moved when the site was split into Products (what
  // you buy) and Solutions (who you are) on 2026-09-23 — see lib/catalog.ts.
  // Permanent, so search engines move the ranking to the new URL.
  async redirects() {
    return [
      { source: "/solutions/seo", destination: "/products/seo", permanent: true },
      { source: "/addons", destination: "/pricing", permanent: true },
    ];
  },
};

export default nextConfig;
