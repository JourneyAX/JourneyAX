/**
 * GET /api/insights?projectId=… — REAL per-project journey insights (B5).
 *
 * Aggregates the agent's own session persistence (journeyx.sessions, written by
 * SessionStore every turn) + the knowledge corpus. Powers Dashboard, Analytics
 * and the Orders/Quotes view — replacing all mock KPIs/funnels/leads.
 */
import { NextResponse } from "next/server";
import { getOrSet, cacheKey } from "@journeyax/cache";
import { knowledgeDb } from "../../../lib/mongo-server";
import { requireAuth, scopeTenant } from "../../../lib/require-auth";

const STAGES = ["intro", "clarify", "products", "quote", "ordered", "installation"] as const;

export async function GET(req: Request) {
  try {
    const auth = await requireAuth(req, "analytics.read");
    if (!auth.ok) return NextResponse.json({ error: auth.message }, { status: auth.status });
    const url = new URL(req.url);
    const projectId = scopeTenant(auth.identity, url.searchParams.get("projectId"));
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

    /* Dashboard, Analytics and Orders all read this one endpoint, and people
     * move between those tabs constantly — recomputing nine aggregates for
     * every switch is what made the console feel slow. `?refresh=1` forces a
     * recount for the Refresh button. */
    const force = url.searchParams.get("refresh") === "1";
    return NextResponse.json(await getOrSet(cacheKey(projectId, "insights"), () =>
      computeInsights(projectId), { ttlSeconds: 120, force }));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

async function computeInsights(projectId: string) {
  {
    const db = await knowledgeDb();
    const sessions = db.collection("sessions");
    const documents = db.collection("documents");
    const tenantFilter = { tenantId: projectId };

    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const since24h = new Date(Date.now() - 24 * 3600 * 1000);

    const [total, last7d, last24h, stageAgg, intentAgg, turnAgg, recent, quoteDocs, orderDocs, docs] = await Promise.all([
      sessions.countDocuments(tenantFilter),
      sessions.countDocuments({ ...tenantFilter, updatedAt: { $gte: since7d } }),
      sessions.countDocuments({ ...tenantFilter, updatedAt: { $gte: since24h } }),
      sessions.aggregate([
        { $match: tenantFilter },
        { $group: { _id: { $ifNull: ["$lastIntent.stage", "intro"] }, n: { $sum: 1 } } },
      ]).toArray(),
      sessions.aggregate([
        { $match: { ...tenantFilter, "lastIntent.intent": { $exists: true } } },
        { $group: { _id: "$lastIntent.intent", n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 8 },
      ]).toArray(),
      sessions.aggregate([
        { $match: tenantFilter },
        { $group: { _id: null, turns: { $sum: { $ifNull: ["$turnCount", 0] } } } },
      ]).toArray(),
      sessions.find(tenantFilter).sort({ updatedAt: -1 }).limit(10)
        .project({ _id: 0, sessionId: 1, lastIntent: 1, turnCount: 1, updatedAt: 1, "state.phase": 1 }).toArray(),
      /* The Orders & Quotes view.
       *
       * This used to read sessions carrying `state.bom` — the shape quotes had
       * BEFORE the authoritative quote engine (P0-04). Nothing writes that any
       * more: quotes are their own collection and orders another, so the screen
       * showed nothing while 52 real quotes and 3 real orders sat in the
       * database. Read them where they actually live. */
      db.collection("quotes").find(tenantFilter).sort({ createdAt: -1 }).limit(25)
        .project({ _id: 0, quoteId: 1, sessionId: 1, title: 1, total: 1, symbol: 1, status: 1,
                   createdAt: 1, updatedAt: 1, lines: 1 }).toArray(),
      db.collection("orders").find(tenantFilter).sort({ createdAt: -1 }).limit(25)
        .project({ _id: 0, orderId: 1, quoteId: 1, status: 1, total: 1, currency: 1,
                   createdAt: 1, paidAt: 1 }).toArray(),
      // projectId is indexed; the $or that also matched metadata.brand forced a
      // collection scan and cost a second on its own (1021ms vs 44ms measured).
      documents.countDocuments({ projectId }),
    ]);

    // Funnel: a session that reached stage N passed through the stages before it.
    const stageCounts: Record<string, number> = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const s of stageAgg) if (s._id in stageCounts) stageCounts[s._id as string] = s.n;
    const reachedAtLeast = STAGES.map((_, i) =>
      STAGES.slice(i).reduce((sum, st) => sum + (stageCounts[st] || 0), 0),
    );
    const funnel = STAGES.map((stage, i) => ({ stage, reached: reachedAtLeast[i] }));

    /* An order supersedes the quote it was placed from — the same job should
       read "ordered", not sit in the list twice. */
    const orderByQuote = new Map<string, any>();
    for (const o of orderDocs as any[]) if (o.quoteId) orderByQuote.set(o.quoteId, o);

    const quotes = (quoteDocs as any[]).map((q: any) => {
      const lines = q.lines ?? [];
      const order = orderByQuote.get(q.quoteId);
      return {
        // The table keys rows on sessionId; the quote id is the stable identity
        // when a quote was built outside a chat session.
        sessionId: q.sessionId || q.quoteId,
        quoteId: q.quoteId,
        orderId: order?.orderId,
        updatedAt: q.updatedAt || q.createdAt,
        // "ordered" once money has actually been taken for it.
        phase: order?.status === 'paid' ? 'ordered' : (q.status || 'quote'),
        items: lines.length,
        // Totals are stored in currency units by the quote engine; this view
        // renders cents.
        totalCents: Math.round((q.total ?? 0) * 100),
        itemNames: lines.slice(0, 3).map((l: any) => l.name).filter(Boolean),
        lines: lines.map((l: any) => ({
          name: l.name, sku: l.sku, category: l.category,
          price: l.unitPrice ?? 0, quantity: l.quantity ?? 1,
        })),
      };
    });

    const orders = (orderDocs as any[]).map((o: any) => ({
      orderId: o.orderId, quoteId: o.quoteId, status: o.status,
      totalCents: Math.round((o.total ?? 0) * 100),
      currency: o.currency, createdAt: o.createdAt, paidAt: o.paidAt ?? null,
    }));

    return {
      projectId,
      sessions: { total, last7d, last24h, totalTurns: turnAgg[0]?.turns ?? 0 },
      funnel,
      intents: intentAgg.map((i) => ({ intent: i._id, n: i.n })),
      recent,
      quotes,
      orders,
      ordersPaid: orders.filter((o) => o.status === 'paid').length,
      knowledgeDocs: docs,
    };
  }
}
