/**
 * GET /api/catalogue/item?projectId=…&url=… — full detail for ONE product page:
 * merged metadata across all its chunks (specs, images, variants, documents,
 * description) + the raw chunk texts, so the console can show exactly what the
 * agent grounds on. Powers the Catalogue drill-down drawer.
 */
import { NextResponse } from "next/server";
import { getOrSet, cacheKey } from "@journeyax/cache";
import { requireAuth, scopeTenant } from "../../../../lib/require-auth";

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "knowledge.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const u = new URL(req.url);
    const projectId = scopeTenant(auth.identity, u.searchParams.get("projectId"));
    const url = u.searchParams.get("url");
    if (!projectId || !url) return NextResponse.json({ error: "projectId and url required" }, { status: 400 });

    const force = u.searchParams.get("refresh") === "1";
    return NextResponse.json(await getOrSet(
      cacheKey(projectId, "catalogue-item", { url }),
      async () => {
        const res = await fetch(`${GATEWAY_URL}/api/v1/${projectId}/products/catalogue/item?url=${encodeURIComponent(url)}`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        
        if (!res.ok) {
          if (res.status === 404) throw new Error("not found");
          throw new Error(`Gateway returned ${res.status}`);
        }

        return res.json();
      },
      { ttlSeconds: 600, force },
    ));
  } catch (e: any) {
    if (e.message === "not found") return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
