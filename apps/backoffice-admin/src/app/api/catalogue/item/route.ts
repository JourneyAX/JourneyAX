/**
 * GET /api/catalogue/item?projectId=…&url=… — full detail for ONE product page:
 * merged metadata across all its chunks (specs, images, variants, documents,
 * description) + the raw chunk texts, so the console can show exactly what the
 * agent grounds on. Powers the Catalogue drill-down drawer.
 */
import { NextResponse } from "next/server";
import { documentsCollection } from "../../../../lib/mongo-server";
import { requireAuth, scopeTenant } from "../../../../lib/require-auth";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "knowledge.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const u = new URL(req.url);
    const projectId = scopeTenant(auth.identity, u.searchParams.get("projectId"));
    const url = u.searchParams.get("url");
    if (!projectId || !url) return NextResponse.json({ error: "projectId and url required" }, { status: 400 });

    const col = await documentsCollection();
    const chunks = await col
      .find({ $and: [{ $or: [{ projectId }, { "metadata.brand": projectId }] }, { sourceUrl: url }] })
      .project({ _id: 0, title: 1, chunk: 1, chunkIndex: 1, metadata: 1, updatedAt: 1 })
      .sort({ chunkIndex: 1 })
      .toArray();
    if (!chunks.length) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Merge metadata across chunks (later chunks may carry variants/documents).
    const merged: any = { specs: {}, images: [], variants: [], documents: [], finishes: [] };
    let title = "";
    for (const c of chunks as any[]) {
      const m = c.metadata || {};
      if (c.title && !/^[-–—\s]/.test(c.title) && c.title.length > title.length) title = c.title;
      Object.assign(merged.specs, m.specs || {});
      for (const k of ["images", "variants", "documents", "finishes"] as const) {
        for (const v of m[k] || []) {
          if (!merged[k].some((x: any) => JSON.stringify(x) === JSON.stringify(v))) merged[k].push(v);
        }
      }
      for (const k of ["sku", "price", "currency", "category", "collection", "description", "availability", "type"]) {
        if (merged[k] == null && m[k] != null) merged[k] = m[k];
      }
    }

    return NextResponse.json({
      url,
      title: title || (chunks[0] as any).title,
      ...merged,
      updatedAt: (chunks[0] as any).updatedAt,
      chunks: (chunks as any[]).map((c) => ({ index: c.chunkIndex, text: String(c.chunk || "").slice(0, 1200) })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
