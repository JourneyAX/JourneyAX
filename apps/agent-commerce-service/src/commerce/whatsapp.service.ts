import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { connectToDatabase } from '@journeyax/database';

const DB_NAME = 'journeyx';
const DEDUPE_COLLECTION = 'wa_dedupe';
const SESSION_COLLECTION = 'wa_sessions';
const DEDUPE_TTL_SECONDS = 60 * 60 * 24;

@Injectable()
export class WhatsAppService {
  private indexesReady = false;

  private async db() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    const { db } = await connectToDatabase(uri, DB_NAME);
    if (!this.indexesReady) {
      await Promise.all([
        db.collection(DEDUPE_COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: DEDUPE_TTL_SECONDS }),
        db.collection(SESSION_COLLECTION).createIndex({ tenantId: 1, phoneHash: 1 }, { unique: true }),
      ]).catch(() => { /* index may already exist */ });
      this.indexesReady = true;
    }
    return db;
  }

  private hashPhone(tenantId: string, phone: string): string {
    return createHash('sha256').update(`${tenantId}:${phone}`).digest('hex');
  }

  async alreadyProcessed(messageId: string): Promise<boolean> {
    try {
      const d = await this.db();
      await d.collection(DEDUPE_COLLECTION).insertOne({ _id: messageId as any, createdAt: new Date() });
      return false;
    } catch (e: any) {
      if (e?.code === 11000) return true;
      console.error('[wa-store] dedupe error', e);
      return false;
    }
  }

  async resolveSessionId(tenantId: string, phone: string): Promise<string> {
    const phoneHash = this.hashPhone(tenantId, phone);
    const d = await this.db();
    const sessionId = 'wa_' + randomBytes(18).toString('hex');
    const res = await d.collection(SESSION_COLLECTION).findOneAndUpdate(
      { tenantId, phoneHash },
      { $setOnInsert: { tenantId, phoneHash, sessionId, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
    return (res as any)?.value?.sessionId || (res as any)?.sessionId || sessionId;
  }
}
