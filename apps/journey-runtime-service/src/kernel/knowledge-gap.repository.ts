import { Collection } from 'mongodb';
import { connectToDatabase, COLLECTION_KNOWLEDGE_GAPS, KnowledgeGapRecord } from '@journeyax/database';

export interface RecordKnowledgeGapInput {
  tenantId: string;
  environmentId?: string;
  topic: string;
  toolName: string;
  conversationId: string;
  recordedAt?: Date;
  metadata?: Record<string, unknown>;
}

export class KnowledgeGapRepository {
  private col: Collection<KnowledgeGapRecord> | null = null;
  private inMemoryGaps: KnowledgeGapRecord[] = [];

  constructor(private readonly customDbOrProvider?: any) {
    if (customDbOrProvider && typeof customDbOrProvider.collection === 'function') {
      this.col = customDbOrProvider.collection(COLLECTION_KNOWLEDGE_GAPS);
    }
  }

  private async getCol(): Promise<Collection<KnowledgeGapRecord> | null> {
    if (this.col) return this.col;
    if (typeof this.customDbOrProvider === 'function') {
      try {
        const resolved = await this.customDbOrProvider();
        if (resolved && typeof resolved.collection === 'function') {
          this.col = resolved.collection(COLLECTION_KNOWLEDGE_GAPS);
          return this.col;
        }
      } catch {
        // Fall back to connection URI or memory
      }
    }
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<KnowledgeGapRecord>(COLLECTION_KNOWLEDGE_GAPS);
      return this.col;
    } catch {
      return null;
    }
  }

  async recordGap(input: RecordKnowledgeGapInput): Promise<KnowledgeGapRecord> {
    const recordedAt = input.recordedAt || new Date();
    const record: KnowledgeGapRecord = {
      tenantId: input.tenantId,
      tenant: input.tenantId,
      environmentId: input.environmentId || 'production',
      topic: input.topic,
      toolName: input.toolName,
      conversationId: input.conversationId,
      recordedAt,
      time: recordedAt.toISOString(),
      createdAt: recordedAt,
      metadata: input.metadata,
    };

    const col = await this.getCol();
    if (col) {
      try {
        await col.insertOne({ ...record });
      } catch {
        this.inMemoryGaps.push(record);
      }
    } else {
      this.inMemoryGaps.push(record);
    }

    return record;
  }

  async countGaps(filter: string | { tenantId: string; environmentId?: string }): Promise<number> {
    const tenantId = typeof filter === 'string' ? filter : filter.tenantId;
    const environmentId = typeof filter === 'object' ? filter.environmentId : undefined;
    const col = await this.getCol();
    if (col) {
      try {
        const query: any = { $or: [{ tenantId }, { tenant: tenantId }] };
        if (environmentId) query.environmentId = environmentId;
        return await col.countDocuments(query);
      } catch {
        return this.inMemoryGaps.filter(
          (g) => (g.tenantId === tenantId || g.tenant === tenantId) && (!environmentId || g.environmentId === environmentId)
        ).length;
      }
    }
    return this.inMemoryGaps.filter(
      (g) => (g.tenantId === tenantId || g.tenant === tenantId) && (!environmentId || g.environmentId === environmentId)
    ).length;
  }

  async listGaps(filter: string | { tenantId: string; environmentId?: string }): Promise<KnowledgeGapRecord[]> {
    const tenantId = typeof filter === 'string' ? filter : filter.tenantId;
    const environmentId = typeof filter === 'object' ? filter.environmentId : undefined;
    const col = await this.getCol();
    if (col) {
      try {
        const query: any = { $or: [{ tenantId }, { tenant: tenantId }] };
        if (environmentId) query.environmentId = environmentId;
        return await col.find(query).sort({ recordedAt: -1 }).toArray();
      } catch {
        return this.inMemoryGaps.filter(
          (g) => (g.tenantId === tenantId || g.tenant === tenantId) && (!environmentId || g.environmentId === environmentId)
        );
      }
    }
    return this.inMemoryGaps.filter(
      (g) => (g.tenantId === tenantId || g.tenant === tenantId) && (!environmentId || g.environmentId === environmentId)
    );
  }
}
