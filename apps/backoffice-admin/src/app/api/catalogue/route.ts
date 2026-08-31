/**
 * GET /api/catalogue?projectId=…&q=…&limit=… — REAL per-project catalogue (B5).
 * Lists product-type documents from the project's ingested knowledge corpus,
 * deduped by sourceUrl (one row per product page). Replaces the static
 * Workwear product rows.
 */
import { NextResponse } from "next/server";
import { getOrSet, cacheKey } from "@journeyax/cache";
import { requireAuth, scopeTenant } from "../../../lib/require-auth";

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "knowledge.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    const projectId = scopeTenant(auth.identity, url.searchParams.get("projectId"));
    const q = url.searchParams.get("q")?.trim() || "";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    const force = url.searchParams.get("refresh") === "1";
    return NextResponse.json(await getOrSet(
      cacheKey(projectId, "catalogue", { q, limit }),
      async () => {
        const res = await fetch(`${GATEWAY_URL}/api/v1/${projectId}/products/catalogue?q=${encodeURIComponent(q)}&limit=${limit}`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
        return res.json();
      },
      { ttlSeconds: 600, force },
    ));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

