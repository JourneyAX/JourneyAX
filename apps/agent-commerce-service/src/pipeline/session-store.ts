/**
 * SessionStore — server-side session persistence (Mongo `sessions`).
 *
 * Replaces relying solely on client-passed `state`: each turn we persist the
 * conversation's state + last intent, keyed by sessionId. This gives:
 *   - continuity/recovery: if the client reloads or sends empty state, the server
 *     restores the last known state for that session.
 *   - analytics: the back office can read `sessions` for funnel/stage metrics.
 *
 * Lazy, resilient connection (like product-service): if Mongo is unavailable the
 * agent degrades to stateless behaviour rather than failing.
 */
import { connectToDatabase } from '@journeyax/database';
import { Collection } from 'mongodb';

const DB_NAME = 'journeyx';
const SESSIONS = 'sessions';

export interface SessionDoc {
  sessionId: string;
  tenantId: string;
  /** Server-owned conversation transcript — the client no longer holds this. */
  messages?: any[];
  /** Typed journey working memory + capability ledger (see journey-memory.ts). */
  journeyState?: any;
  /** Optional rolling summary of older turns (context editing). */
  summary?: string;
  /** Durable customer identity when signed in (long-term memory key). */
  customerId?: string;
  state?: any;              // legacy UI-state snapshot (kept for back-compat)
  lastIntent?: { intent: string; stage: string; mode: string };
  turnCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class SessionStore {
  private col: Collection<SessionDoc> | null = null;
  private tried = false;

  private async getCol(): Promise<Collection<SessionDoc> | null> {
    if (this.col) return this.col;
    if (this.tried) return null; // don't retry a known-bad connection every turn
    this.tried = true;
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.warn('[SessionStore] MONGODB_URI not set — sessions not persisted.');
      return null;
    }
    try {
      const { db } = await connectToDatabase(uri, DB_NAME);
      this.col = db.collection<SessionDoc>(SESSIONS);
      await this.col.createIndex({ sessionId: 1 }, { unique: true }).catch(() => {});
      await this.col.createIndex({ tenantId: 1, updatedAt: -1 }).catch(() => {});
      return this.col;
    } catch (e) {
      console.warn('[SessionStore] Mongo unavailable — sessions not persisted:', (e as Error).message);
      return null;
    }
  }

  async load(sessionId: string, tenantId?: string): Promise<SessionDoc | null> {
    const col = await this.getCol();
    if (!col) return null;
    try {
      // Tenant-scoped lookup (P0-03): a leaked sessionId can't be replayed cross-tenant.
      const filter: any = tenantId ? { sessionId, tenantId } : { sessionId };
      return await col.findOne(filter, { projection: { _id: 0 } });
    } catch {
      return null;
    }
  }

  async save(input: {
    sessionId: string;
    tenantId: string;
    messages?: any[];
    journeyState?: any;
    summary?: string;
    customerId?: string;
    state?: any;
    lastIntent?: { intent: string; stage: string; mode: string };
  }): Promise<void> {
    const col = await this.getCol();
    if (!col) return;
    const now = new Date();
    try {
      const $set: any = { tenantId: input.tenantId, lastIntent: input.lastIntent, updatedAt: now };
      if (input.messages !== undefined) $set.messages = input.messages;
      if (input.journeyState !== undefined) $set.journeyState = input.journeyState;
      if (input.summary !== undefined) $set.summary = input.summary;
      if (input.customerId !== undefined) $set.customerId = input.customerId;
      if (input.state !== undefined) $set.state = input.state;
      await col.updateOne(
        { sessionId: input.sessionId },
        { $set, $inc: { turnCount: 1 }, $setOnInsert: { sessionId: input.sessionId, createdAt: now } },
        { upsert: true },
      );
    } catch (e) {
      console.warn('[SessionStore] save failed:', (e as Error).message);
    }
  }
}
