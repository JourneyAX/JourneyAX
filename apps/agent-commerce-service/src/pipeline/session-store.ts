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

/**
 * One entry per tool call the agent made during a turn — a lightweight,
 * human-readable trace of "what the agent actually did" (distinct from the
 * full message transcript). Consumed by analytics-service's getTranscript.
 */
export interface SessionStep {
  turnIndex: number;
  tool: string;
  /** Short, safely-truncated plain-text summary of the call's arguments — never a raw JSON dump. */
  argsSummary: string;
  /** Short, safely-truncated plain-text summary of the call's result. */
  resultSummary: string;
  ts: string;
}

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
  /** Per-tool-call trace across the session's turns — see SessionStep. */
  steps?: SessionStep[];
  turnCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Cap on truncated one-line summaries — keeps steps[] cheap to store and read.
const SUMMARY_MAX_LEN = 160;

function truncate(s: string, max = SUMMARY_MAX_LEN): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Turns a tool name + its raw args/result objects into short, human-readable
 * one-liners for the session trace. Special-cases the tools whose args/result
 * shapes are worth summarising meaningfully; anything else falls back to a
 * generic truncated JSON dump.
 */
export function summarizeToolCall(
  tool: string,
  args: any,
  result: any,
): { argsSummary: string; resultSummary: string } {
  const fallback = (v: any) => {
    try {
      return truncate(JSON.stringify(v ?? {}));
    } catch {
      return '';
    }
  };

  switch (tool) {
    case 'searchKnowledge': {
      const parts = [args?.query, args?.type, args?.category].filter(Boolean);
      const argsSummary = truncate(parts.length ? `query: ${parts.join(', ')}` : 'query: (empty)');
      const count = Array.isArray(result?.items) ? result.items.length
        : Array.isArray(result?.results) ? result.results.length
        : undefined;
      const resultSummary = truncate(
        result?.found === false ? (result?.message || 'no results found')
          : count !== undefined ? `${count} result${count === 1 ? '' : 's'} found`
          : fallback(result),
      );
      return { argsSummary, resultSummary };
    }
    case 'recommendSize': {
      const argsSummary = truncate(`size query: ${[args?.measurement, args?.value, args?.unit].filter(Boolean).join(' ')}` || fallback(args));
      const size = result?.recommendedSize ?? result?.size;
      const available = Array.isArray(result?.availableSizes) ? result.availableSizes.length : undefined;
      const resultSummary = truncate(
        size ? `recommended size ${size}${available !== undefined ? `, ${available} sizes available` : ''}`
          : result?.message || fallback(result),
      );
      return { argsSummary, resultSummary };
    }
    case 'showItems': {
      const items = Array.isArray(args?.items) ? args.items : Array.isArray(args?.skus) ? args.skus : [];
      const argsSummary = truncate(items.length ? `${items.length} item(s) to show` : fallback(args));
      const resultSummary = truncate(result?.success === false ? (result?.message || 'rejected') : 'shown');
      return { argsSummary, resultSummary };
    }
    case 'showConfigurator': {
      const argsSummary = truncate(args?.sku ? `sku: ${args.sku}` : fallback(args));
      const resultSummary = truncate(result?.success === false ? (result?.message || 'rejected') : 'configurator rendered');
      return { argsSummary, resultSummary };
    }
    case 'updateQuote': {
      const itemCount = Array.isArray(args?.items) ? args.items.length : undefined;
      const argsSummary = truncate(itemCount !== undefined ? `${itemCount} line item(s)` : fallback(args));
      const resultSummary = truncate(
        result?.success === false ? (result?.message || 'rejected')
          : `quote ${result?.quoteId || ''} total ${result?.total ?? '?'} ${result?.currency || ''}`.trim(),
      );
      return { argsSummary, resultSummary };
    }
    case 'setPhase': {
      const argsSummary = truncate(`phase: ${args?.phase || '?'}`);
      const resultSummary = truncate(result?.success === false ? (result?.message || 'rejected') : 'ok');
      return { argsSummary, resultSummary };
    }
    case 'researchSchool': {
      const argsSummary = truncate(args?.school || args?.query ? `school: ${args.school || args.query}` : fallback(args));
      const resultSummary = truncate(
        result?.error ? result.error : `team ${result?.team || '?'}, mascot ${result?.mascot || '?'}, confidence ${result?.confidence ?? '?'}`,
      );
      return { argsSummary, resultSummary };
    }
    default:
      return { argsSummary: fallback(args), resultSummary: fallback(result) };
  }
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

  /**
   * Append one tool-call trace entry for this session. Best-effort — a failed
   * append never blocks the turn (same resilience posture as save()). Keeps
   * only the most recent 500 steps per session so the doc can't grow unbounded.
   */
  async appendStep(sessionId: string, tenantId: string, step: SessionStep): Promise<void> {
    const col = await this.getCol();
    if (!col) return;
    try {
      await col.updateOne(
        { sessionId },
        {
          $push: { steps: { $each: [step], $slice: -500 } } as any,
          $set: { tenantId, updatedAt: new Date() },
          $setOnInsert: { sessionId, createdAt: new Date(), turnCount: 0 },
        },
        { upsert: true },
      );
    } catch (e) {
      console.warn('[SessionStore] appendStep failed:', (e as Error).message);
    }
  }
}
