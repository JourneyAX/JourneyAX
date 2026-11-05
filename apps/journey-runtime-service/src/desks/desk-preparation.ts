import { createHash, randomUUID } from 'node:crypto';

export interface DeskPreparationInput {
  tenantId: string; environmentId: string; principalId: string; deskId: string; recordId: string;
  releaseChecksum: string; sourceRevision: unknown; sessionId: string;
}
export interface PreparedDeskWork { ok: true; status: 'preparing' | 'ready' | 'waiting_for_approval' | 'failed'; workId: string; sessionId: string; summary?: string; cards?: Array<{ cardType: string; state: Record<string, unknown> }>; }

/** Durable deduplication of a scoped investigation. It never implements a conversational playbook or calls a vendor itself. */
export class DeskPreparationStore {
  constructor(private readonly getDb: () => Promise<any>, private readonly now = () => new Date()) {}
  async read(scope: Omit<DeskPreparationInput, 'sourceRevision'>, workId: string): Promise<PreparedDeskWork | undefined> {
    if (!/^[a-f0-9]{64}$/.test(workId)) return undefined;
    const db = await this.getDb(); if (!db) throw new Error('Durable investigation storage is unavailable.');
    const { sessionId, ...where } = scope;
    const record = await db.collection('desk_agent_work').findOne({ _id: workId, ...where });
    return record && (!record.expiresAt || new Date(record.expiresAt) > this.now()) ? { ok: true, status: record.status === 'queued' ? 'preparing' : record.status, workId, sessionId, summary: record.summary, cards: record.cards } : undefined;
  }
  async prepare(input: DeskPreparationInput, run: () => Promise<{ summary: string; cards: Array<{ cardType: string; state: Record<string, unknown> }> }>): Promise<PreparedDeskWork> {
    const db = await this.getDb();
    if (!db) throw new Error('Durable investigation storage is unavailable.');
    const collection = db.collection('desk_agent_work');
    const id = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const scope = { _id: id, tenantId: input.tenantId, environmentId: input.environmentId, principalId: input.principalId };
    const at = this.now();
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    try { await collection.insertOne({ ...scope, deskId: input.deskId, recordId: input.recordId, releaseChecksum: input.releaseChecksum, status: 'queued', createdAt: at, expiresAt: new Date(at.getTime() + 86400_000) }); } catch (error: any) { if (error?.code !== 11000) throw error; }
    await collection.updateOne({ ...scope, $or: [{ expiresAt: { $lt: at } }, { status: 'failed', retryAt: { $lte: at } }] }, { $set: { status: 'queued', expiresAt: new Date(at.getTime() + 86400_000) }, $unset: { summary: '', cards: '', retryAt: '' } });
    const token = randomUUID();
    const claimed = await collection.findOneAndUpdate({ ...scope, $or: [{ status: 'queued' }, { status: 'preparing', leaseUntil: { $lt: at } }] }, { $set: { status: 'preparing', lease: token, leaseUntil: new Date(at.getTime() + 120_000) } }, { returnDocument: 'after' });
    const publicWork = (record: any): PreparedDeskWork => ({ ok: true, status: record?.status === 'queued' ? 'preparing' : record?.status ?? 'preparing', workId: id, sessionId: input.sessionId, summary: record?.summary, cards: record?.cards });
    if (!claimed) return publicWork(await collection.findOne(scope));
    let renewing = Promise.resolve();
    const heartbeat = setInterval(() => { renewing = renewing.then(async () => { await collection.updateOne({ ...scope, lease: token, status: 'preparing' }, { $set: { leaseUntil: new Date(this.now().getTime() + 120_000) } }); }).catch(() => {}); }, 30_000);
    try {
      const result = await run();
      if (!result.summary.trim()) throw new Error('The investigation returned no usable answer.');
      const status = result.cards.some(card => card.cardType === 'confirm') ? 'waiting_for_approval' : 'ready';
      // A delayed worker cannot replace the result of the worker that reclaimed its lease.
      const saved = await collection.updateOne({ ...scope, lease: token, status: 'preparing' }, { $set: { status, summary: result.summary, cards: result.cards, completedAt: this.now() }, $unset: { lease: '', leaseUntil: '' } });
      return saved.matchedCount ? { ok: true, status, workId: id, sessionId: input.sessionId, ...result } : publicWork(await collection.findOne(scope));
    } catch {
      await collection.updateOne({ ...scope, lease: token, status: 'preparing' }, { $set: { status: 'failed', completedAt: this.now(), retryAt: new Date(this.now().getTime() + 30_000) }, $unset: { lease: '', leaseUntil: '' } });
      return { ok: true, status: 'failed', workId: id, sessionId: input.sessionId };
    } finally {
      clearInterval(heartbeat); await renewing;
    }
  }
}
