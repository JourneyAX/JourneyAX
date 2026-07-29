/**
 * GET /api/catalogue?projectId=…&q=…&limit=… — REAL per-project catalogue (B5).
 * Lists product-type documents from the project's ingested knowledge corpus,
 * deduped by sourceUrl (one row per product page). Replaces the static
 * Workwear product rows.
 */
import { NextResponse } from "next/server";
import { getOrSet, cacheKey } from "@journeyax/cache";
import { documentsCollection } from "../../../lib/mongo-server";
import { requireAuth, scopeTenant } from "../../../lib/require-auth";

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "knowledge.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    const projectId = scopeTenant(auth.identity, url.searchParams.get("projectId"));
    const q = url.searchParams.get("q")?.trim();
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    /* The catalogue is a read-only view of an ingested corpus that only changes
     * when an ingest runs, and it was measured re-running the same aggregation
     * three times per visit. Cache it per project and per query. */
    const force = url.searchParams.get("refresh") === "1";
    return NextResponse.json(await getOrSet(
      cacheKey(projectId, "catalogue", { q: q || "", limit }),
      () => listCatalogue(projectId, q, limit),
      { ttlSeconds: 600, force },
    ));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function listCatalogue(projectId: string, q: string | undefined, limit: number) {
  {
    const col = await documentsCollection();
    /* One tenant field, not an $or.
     *
     * `metadata.brand` is the field the vector index and every other read
     * already filter on, and it is now populated for every document of every
     * project (verified: augusta 11818/11818, caroma 3770/3770). The $or that
     * also tried `projectId` could use no index and made this the slowest
     * screen in the console — 15.7s against 2.5s for the single-field form. */
    const match: any = { "metadata.brand": projectId, "metadata.type": "product" };
    if (q) match.$and.push({ $or: [{ title: { $regex: q, $options: "i" } }, { "metadata.sku": { $regex: q, $options: "i" } }] });

    const rows = await col.aggregate([
      { $match: match },
      /* Drop to the fields this view renders BEFORE sorting and grouping.
       * Every document carries a 1536-dimension embedding and its full text;
       * carrying those through a sort of thousands of chunks is most of what
       * made this slow (the same trap as the pricebook, AUG-43). */
      { $project: {
          sourceUrl: 1, title: 1, updatedAt: 1,
          "metadata.sku": 1, "metadata.price": 1, "metadata.currency": 1,
          "metadata.category": 1, "metadata.collection": 1, "metadata.images": 1,
          "metadata.availability": 1, "metadata.specs": 1,
      } },
      { $sort: { updatedAt: -1 } },
      { $group: {
          _id: "$sourceUrl",
          titles: { $addToSet: "$title" },
          sku: { $first: "$metadata.sku" },
          price: { $first: "$metadata.price" },
          currency: { $first: "$metadata.currency" },
          category: { $first: "$metadata.category" },
          collection: { $first: "$metadata.collection" },
          image: { $first: { $arrayElemAt: ["$metadata.images", 0] } },
          availability: { $first: "$metadata.availability" },
          specCount: { $first: { $size: { $objectToArray: { $ifNull: ["$metadata.specs", {}] } } } },
          updatedAt: { $first: "$updatedAt" },
      } },
      { $limit: limit },
    ]).toArray();

    // Some variant chunks store degenerate titles ("--Brushed Brass"); pick the
    // best-looking title per product: longest one not starting with punctuation.
    for (const r of rows as any[]) {
      const clean = (r.titles as string[])
        .filter((t) => t && !/^[-–—\s]/.test(t))
        .sort((a, b) => b.length - a.length);
      r.title = clean[0] || (r.titles as string[]).sort((a, b) => b.length - a.length)[0] || r.sku || "Untitled";
      delete r.titles;
    }
    rows.sort((a: any, b: any) => String(a.title).localeCompare(String(b.title)));

    const total = await col.aggregate([
      { $match: { "metadata.brand": projectId, "metadata.type": "product" } },
      { $group: { _id: "$sourceUrl" } }, { $count: "n" },
    ]).toArray();

    return {
      products: rows.map(({ _id, ...r }) => ({ url: _id, ...r })),
      totalProducts: total[0]?.n ?? 0,
    };
  }
}
