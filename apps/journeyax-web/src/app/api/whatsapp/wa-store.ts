/**
 * WhatsApp persistence — durable idempotency + opaque session mapping.
 *
 * Replaces two in-process shortcuts that break on restart/scale-out:
 *   • P0-06: the 500-entry in-memory `seen` Set → a Mongo-backed dedupe with a
 *     TTL so Meta's at-least-once retries are ignored even across instances.
 *   • P0-03 tail: the predictable `wa:<tenant>:<phone>` session key → an opaque,
 *     high-entropy id mapped per (tenant, phone-hash). The phone number is never
 *     stored in the key, and the agent session id can't be guessed to replay
 *     another user's conversation.
 *
 * Uses the shared cached Mongo client (@journeyax/database), so there is no
 * per-request connect. All state lives in the `journeyx` DB alongside sessions.
 */
import { createHash, randomBytes } from 'crypto';
import { connectToDatabase } from '@journeyax/database';

const DB_NAME = 'journeyx';
const DEDUPE_COLLECTION = 'wa_dedupe';
const SESSION_COLLECTION = 'wa_sessions';
// Meta retries within minutes; a day of dedupe memory is plenty and TTL keeps
// the collection bounded without any manual cleanup.
const DEDUPE_TTL_SECONDS = 60 * 60 * 24;

let indexesReady = false;

async function db() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  const { db } = await connectToDatabase(uri, DB_NAME);
  if (!indexesReady) {
    await Promise.all([
      db.collection(DEDUPE_COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: DEDUPE_TTL_SECONDS }),
      db.collection(SESSION_COLLECTION).createIndex({ tenantId: 1, phoneHash: 1 }, { unique: true }),
    ]).catch(() => { /* index may already exist */ });
    indexesReady = true;
  }
  return db;
}

/** Phones are PII — key by a salted-ish hash, never the raw number. */
function hashPhone(tenantId: string, phone: string): string {
  return createHash('sha256').update(`${tenantId}:${phone}`).digest('hex');
}

/**
 * Atomic claim: returns true if this messageId was ALREADY processed. The unique
 * _id insert races safely across concurrent deliveries — the loser gets a
 * duplicate-key error, which we read as "already seen".
 */
export async function alreadyProcessed(messageId: string): Promise<boolean> {
  try {
    const d = await db();
    await d.collection(DEDUPE_COLLECTION).insertOne({ _id: messageId as any, createdAt: new Date() });
    return false; // insert succeeded → first time we've seen it
  } catch (e: any) {
    if (e?.code === 11000) return true; // duplicate key → already processed
    // On any other store error, fail OPEN (process the message) rather than drop
    // a real customer message; dedupe is best-effort, delivery is not.
    console.error('[wa-store] dedupe error', e);
    return false;
  }
}

/**
 * Opaque, stable session id for a (tenant, phone) pair. First contact mints a
 * high-entropy id; subsequent messages reuse it so the conversation continues.
 */
export async function resolveSessionId(tenantId: string, phone: string): Promise<string> {
  const phoneHash = hashPhone(tenantId, phone);
  const d = await db();
  const sessionId = 'wa_' + randomBytes(18).toString('hex');
  const res = await d.collection(SESSION_COLLECTION).findOneAndUpdate(
    { tenantId, phoneHash },
    { $setOnInsert: { tenantId, phoneHash, sessionId, createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  return (res as any)?.value?.sessionId || (res as any)?.sessionId || sessionId;
}
