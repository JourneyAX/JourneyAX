/**
 * AnalyticsService — real per-project journey metrics.
 *
 * Owns ALL MongoDB access for the analytics domain. The backoffice used to
 * query MongoDB directly (exposing MONGODB_URI to Vercel). This service is
 * the correct owner: it runs on private Cloud Run, never exposes credentials
 * to a third-party platform, and is reached only through the API gateway.
 *
 * Data sources (all in the 'journeyx' database):
 *   - sessions    — agent session persistence written by SessionStore
 *   - documents   — knowledge corpus entries (for knowledgeDocs count)
 *   - quotes      — quote engine output (P0-04)
 *   - orders      — confirmed orders
 *   - ingest_jobs — knowledge ingest job status
 */
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';

const STAGES = ['intro', 'clarify', 'products', 'quote', 'ordered', 'installation'] as const;
const KNOWLEDGE_DB = 'journeyx';

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyticsService.name);
  private client: MongoClient | null = null;
  private db: Db | null = null;

  private async getDb(): Promise<Db | null> {
    if (this.db) return this.db;
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      this.logger.warn('MONGODB_URI not set — analytics will return empty data');
      return null;
    }
    try {
      this.client = await new MongoClient(uri, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      }).connect();
      this.db = this.client.db(KNOWLEDGE_DB);
      this.logger.log(`Connected to MongoDB (${KNOWLEDGE_DB})`);
      return this.db;
    } catch (e: any) {
      this.logger.error(`MongoDB connection failed: ${e.message}`);
      return null;
    }
  }

  async onModuleInit() {
    await this.getDb();
  }

  async onModuleDestroy() {
    await this.client?.close();
  }

  /** Full insights payload — sessions, funnel, intents, recent, quotes, orders, knowledgeDocs. */
  async computeInsights(projectId: string): Promise<Record<string, unknown>> {
    const db = await this.getDb();
    if (!db) {
      return this.emptyInsights(projectId);
    }

    const sessions  = db.collection('sessions');
    const documents = db.collection('documents');
    const quotes    = db.collection('quotes');
    const orders    = db.collection('orders');

    const tenantFilter = { tenantId: projectId };
    const since7d  = new Date(Date.now() - 7  * 24 * 3600 * 1000);
    const since24h = new Date(Date.now() - 24 *      3600 * 1000);
    const since14d = new Date(Date.now() - 14 * 24 * 3600 * 1000);

    try {
      const [
        total, last7d, last24h,
        stageAgg, intentAgg, turnAgg,
        recent, quoteDocs, orderDocs, docs, dailyAgg,
      ] = await Promise.all([
        sessions.countDocuments(tenantFilter),
        sessions.countDocuments({ ...tenantFilter, updatedAt: { $gte: since7d } }),
        sessions.countDocuments({ ...tenantFilter, updatedAt: { $gte: since24h } }),
        sessions.aggregate([
          { $match: tenantFilter },
          { $group: { _id: { $ifNull: ['$lastIntent.stage', 'intro'] }, n: { $sum: 1 } } },
        ]).toArray(),
        sessions.aggregate([
          { $match: { ...tenantFilter, 'lastIntent.intent': { $exists: true } } },
          { $group: { _id: '$lastIntent.intent', n: { $sum: 1 } } },
          { $sort: { n: -1 } }, { $limit: 8 },
        ]).toArray(),
        sessions.aggregate([
          { $match: tenantFilter },
          { $group: { _id: null, turns: { $sum: { $ifNull: ['$turnCount', 0] } } } },
        ]).toArray(),
        sessions.find(tenantFilter, { projection: { _id: 0, sessionId: 1, lastIntent: 1, turnCount: 1, updatedAt: 1, 'state.phase': 1 } })
          .sort({ updatedAt: -1 }).limit(10).toArray(),
        quotes.find(tenantFilter, { projection: { _id: 0, quoteId: 1, sessionId: 1, title: 1, total: 1, symbol: 1, status: 1, createdAt: 1, updatedAt: 1, lines: 1 } })
          .sort({ createdAt: -1 }).limit(25).toArray(),
        orders.find(tenantFilter, { projection: { _id: 0, orderId: 1, quoteId: 1, status: 1, total: 1, currency: 1, createdAt: 1, paidAt: 1 } })
          .sort({ createdAt: -1 }).limit(25).toArray(),
        documents.countDocuments({ projectId }),
        // Sessions grouped by day (last 14 days) — real day-by-day activity for
        // the trend chart. Grouped on updatedAt since that's what every session
        // write touches (createdAt is only set once, updatedAt on every turn).
        sessions.aggregate([
          { $match: { ...tenantFilter, updatedAt: { $gte: since14d } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$updatedAt' } }, n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

    // Daily sessions trend: fill in the missing days as 0 so the chart has a
    // continuous 14-point series rather than gaps where no session touched.
    const dailyCounts = new Map<string, number>();
    for (const d of dailyAgg as any[]) dailyCounts.set(d._id, d.n);
    const sessionsByDay: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = d.toISOString().slice(0, 10);
      sessionsByDay.push({ date: key, count: dailyCounts.get(key) || 0 });
    }

    // Funnel: cumulative — a session that reached stage N also passed all prior stages
    const stageCounts: Record<string, number> = Object.fromEntries(STAGES.map(s => [s, 0]));
    for (const s of stageAgg) if (s._id in stageCounts) stageCounts[s._id as string] = s.n;
    const reachedAtLeast = STAGES.map((_, i) =>
      STAGES.slice(i).reduce((sum, st) => sum + (stageCounts[st] || 0), 0),
    );
    const funnel = STAGES.map((stage, i) => ({ stage, reached: reachedAtLeast[i] }));

    // Merge orders back into quote rows
    const orderByQuote = new Map<string, any>();
    for (const o of orderDocs as any[]) if (o.quoteId) orderByQuote.set(o.quoteId, o);

    const quotesOut = (quoteDocs as any[]).map((q: any) => {
      const lines = q.lines ?? [];
      const order = orderByQuote.get(q.quoteId);
      return {
        sessionId:   q.sessionId || q.quoteId,
        quoteId:     q.quoteId,
        orderId:     order?.orderId,
        updatedAt:   q.updatedAt || q.createdAt,
        phase:       order?.status === 'paid' ? 'ordered' : (q.status || 'quote'),
        items:       lines.length,
        totalCents:  Math.round((q.total ?? 0) * 100),
        itemNames:   lines.slice(0, 3).map((l: any) => l.name).filter(Boolean),
        lines:       lines.map((l: any) => ({
          name: l.name, sku: l.sku, category: l.category,
          price: l.unitPrice ?? 0, quantity: l.quantity ?? 1,
        })),
      };
    });

    const ordersOut = (orderDocs as any[]).map((o: any) => ({
      orderId:    o.orderId,
      quoteId:    o.quoteId,
      status:     o.status,
      totalCents: Math.round((o.total ?? 0) * 100),
      currency:   o.currency,
      createdAt:  o.createdAt,
      paidAt:     o.paidAt ?? null,
    }));

    return {
      projectId,
      sessions: { total, last7d, last24h, totalTurns: turnAgg[0]?.turns ?? 0 },
      funnel,
      intents:      intentAgg.map(i => ({ intent: i._id, n: i.n })),
      recent,
      quotes:       quotesOut,
      orders:       ordersOut,
      ordersPaid:   ordersOut.filter(o => o.status === 'paid').length,
      knowledgeDocs: docs,
      sessionsByDay,
    };
    } catch (err: any) {
      this.logger.error(`Error computing insights for ${projectId}: ${err.message}`);
      return this.emptyInsights(projectId);
    }
  }

  /**
   * Full transcript for ONE session — the real `messages[]` SessionStore
   * writes every turn (see `apps/agent-commerce-service/src/pipeline/
   * session-store.ts`). `computeInsights`'s `recent` list only ever projects
   * light fields (intent/phase/turnCount) — this is the drill-down "what did
   * the customer actually ask, what happened" view on top of the same data.
   * Tenant-scoped so a sessionId can't be replayed to read another project's
   * conversation.
   */
  async getTranscript(projectId: string, sessionId: string): Promise<Record<string, unknown>> {
    if (!this.db) return { sessionId, messages: [], found: false };
    const doc = await this.db.collection('sessions').findOne(
      { sessionId, tenantId: projectId },
      { projection: { _id: 0, sessionId: 1, messages: 1, lastIntent: 1, turnCount: 1, updatedAt: 1, createdAt: 1, 'state.phase': 1, steps: 1 } },
    );
    if (!doc) return { sessionId, messages: [], found: false };
    return { ...doc, found: true };
  }

  private emptyInsights(projectId: string) {
    const sessionsByDay = Array.from({ length: 14 }, (_, idx) => {
      const i = 13 - idx;
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      return { date: d.toISOString().slice(0, 10), count: 0 };
    });
    return {
      projectId,
      sessions:     { total: 0, last7d: 0, last24h: 0, totalTurns: 0 },
      funnel:       STAGES.map(stage => ({ stage, reached: 0 })),
      intents:      [],
      recent:       [],
      quotes:       [],
      orders:       [],
      ordersPaid:   0,
      knowledgeDocs: 0,
      sessionsByDay,
    };
  }
}
