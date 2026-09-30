import { adapterRegistry } from '@journeyax/integration';

export interface TurnRetrievalRecord {
  reason: string;
  query: string;
  type?: string;
  category?: string;
  gender?: string;
  reused: boolean;
  durationMs: number;
}

/**
 * Per-turn search memo that collapses identical in-flight searches within a turn
 * while guaranteeing 100% strict filter separation (tenantId, type, category,
 * gender, and limit filter signature). Independent searches run concurrently via
 * Promise.all without blocking.
 */
export class TurnSearchMemo {
  private entries: {
    key: string;
    normKey: string;
    tokens: Set<string>;
    sig: string;
    limit: number;
    tenantId: string;
    p: Promise<any>;
  }[] = [];
  private records: TurnRetrievalRecord[] = [];

  constructor(private readonly tenantId: string) {}

  public static tokens(q: string): Set<string> {
    return new Set(
      String(q || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  }

  public static normalize(q: string): string {
    return String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  getTenantId(): string {
    return this.tenantId;
  }

  getRecords(): TurnRetrievalRecord[] {
    return [...this.records];
  }

  getRetrievalsDuration(): number {
    return this.records.reduce((acc, r) => acc + r.durationMs, 0);
  }

  search(opts: {
    query: string;
    type?: string;
    category?: string;
    limit?: number;
    gender?: string;
    reason?: string;
  }): Promise<any> {
    const reason = opts.reason || 'model_tool';
    const normKey = TurnSearchMemo.normalize(opts.query);
    const tokens = TurnSearchMemo.tokens(opts.query);
    const limit = opts.limit ?? 8;
    // Explicit tenant and filter signature ensuring 100% tenant safety and filter separation:
    // Incompatible type, category, gender, limit, or tenant NEVER share results
    const sig = `${this.tenantId}|${opts.type || ''}|${opts.category || ''}|${opts.gender || ''}|limit:${limit}`;

    for (const e of this.entries) {
      if (e.sig !== sig || e.tenantId !== this.tenantId || e.limit !== limit) {
        continue;
      }

      // True normalized equivalence: exact normalized string or token-set equivalence
      const isExactMatch = e.normKey === normKey;
      const isTokenEquiv = tokens.size > 0 && e.tokens.size === tokens.size && [...tokens].every((t) => e.tokens.has(t));

      if (isExactMatch || isTokenEquiv) {
        return e.p.then((res) => {
          console.log(`[agent:timing] ⏱️ Retrieval [${reason}] type="${opts.type || 'product'}" REUSED exact in-flight search "${e.key}" (0ms) | tenant="${this.tenantId}"`);
          this.records.push({
            reason,
            query: opts.query,
            type: opts.type,
            category: opts.category,
            gender: opts.gender,
            reused: true,
            durationMs: 0,
          });
          return res;
        });
      }
    }

    const tStart = Date.now();
    const recordIndex = this.records.length;
    this.records.push({
      reason,
      query: opts.query,
      type: opts.type,
      category: opts.category,
      gender: opts.gender,
      reused: false,
      durationMs: 0,
    });

    const p = (async () => {
      try {
        const port = await adapterRegistry.getKnowledge(this.tenantId);
        const res = await port.search({ tenantId: this.tenantId }, opts);
        const dur = Date.now() - tStart;
        console.log(`[agent:timing] ⏱️ Retrieval [${reason}] type="${opts.type || 'product'}" completed in ${dur}ms | query="${opts.query}" | tenant="${this.tenantId}"`);
        this.records[recordIndex].durationMs = dur;
        return res;
      } catch (err) {
        const dur = Date.now() - tStart;
        this.records[recordIndex].durationMs = dur;
        // Evict from active entries so subsequent searches do not reuse a failed promise
        const idx = this.entries.findIndex((entry) => entry.p === p);
        if (idx !== -1) this.entries.splice(idx, 1);
        throw err;
      }
    })();

    p.catch(() => {
      /* handled where awaited */
    });

    this.entries.push({
      key: opts.query,
      normKey,
      tokens,
      sig,
      limit,
      tenantId: this.tenantId,
      p,
    });
    return p;
  }
}
