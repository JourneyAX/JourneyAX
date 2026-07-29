/**
 * GET /api/platform/health — REAL health of every platform service (B5).
 * Replaces the static "All systems operational" board: each tile is a live ping
 * to the service's own /health endpoint, with latency.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/require-auth";

// Env vars hold BASE urls (shared with the rest of the app); the health path is
// appended here so a configured base can't accidentally drop the path.
const base = (env: string | undefined, fallback: string) => (env || fallback).replace(/\/$/, "");
const SERVICES: { id: string; name: string; url: string; role: string }[] = [
  { id: "gateway",  name: "API Gateway",        url: `${base(process.env.GATEWAY_URL, "http://localhost:3010")}/health`,                                 role: "Auth, routing, tenant isolation" },
  { id: "agent",    name: "Agent Runtime",      url: `${base(process.env.AGENT_URL, "http://localhost:3004")}/api/v1/platform/commerce/health`,          role: "Journey agent (chat + streaming)" },
  { id: "project",  name: "Project Service",    url: `${base(process.env.PROJECT_API, "http://localhost:8082")}/api/v1/projects/health`,                 role: "Tenant config, versions, rules" },
  { id: "product",  name: "Product Service",    url: `${base(process.env.PRODUCT_API, "http://localhost:8083")}/api/v1/platform/products/health`,        role: "Catalogue search / retrieval" },
  { id: "auth",     name: "Auth Service",       url: `${base(process.env.AUTH_API, "http://localhost:8080")}/api/v1/auth/health`,                        role: "Login, JWT, users" },
  { id: "org",      name: "Organization Service", url: `${base(process.env.ORG_API, "http://localhost:8085")}/api/v1/organizations/health`,              role: "Customer/org containers" },
  { id: "storefront", name: "Storefront",       url: `${base(process.env.STOREFRONT_URL, "http://localhost:3008")}/api/config`,                          role: "Customer journey UI" },
];

export async function GET(req: Request) {
  // Infra health exposes internal topology — analytics.read (manager/admin).
  const auth = await requireAuth(req, "analytics.read");
  if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
  const results = await Promise.all(
    SERVICES.map(async (s) => {
      const t0 = Date.now();
      try {
        const res = await fetch(s.url, { signal: AbortSignal.timeout(3000), cache: "no-store" });
        return { ...s, up: res.ok, status: res.status, latencyMs: Date.now() - t0 };
      } catch {
        return { ...s, up: false, status: 0, latencyMs: Date.now() - t0 };
      }
    }),
  );
  return NextResponse.json({ services: results, allUp: results.every((r) => r.up), checkedAt: new Date().toISOString() });
}
