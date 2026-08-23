import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // ── Ad-hoc Playwright scripts at the repo root ───────────────────────
  // These are throwaway CommonJS scripts run directly with `node`, and they
  // are stale besides: they hardcode localhost:3008 and write screenshots to
  // a macOS path. They are not application code and not part of the build,
  // so the module-system rules do not apply. Kept lintable rather than
  // ignored so genuine mistakes still surface.
  //
  // These should be deleted or rewritten against the real dev port — see
  // CLAUDE.md. Until someone decides which, they stay scoped here.
  {
    files: ["test-*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },

  // ── Ingestion and scraping scripts ───────────────────────────────────
  // Run manually via `npx tsx`, never bundled, and they marshal loosely
  // shaped data from Firecrawl, Playwright and pdftotext. `any` at those
  // boundaries is a deliberate trade rather than an oversight; the rule
  // stays a warning so it is still visible.
  {
    files: ["src/scripts/**/*.ts", "check-db.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
