import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not announce the framework on every response (docs: next.config.js › poweredByHeader).
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
