import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Do not announce the framework on every response (docs: next.config.js › poweredByHeader).
  poweredByHeader: false,
  // A second dev server (the preview storefront, scripts/dev/preview-stack.sh) keeps its build in its own folder.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
