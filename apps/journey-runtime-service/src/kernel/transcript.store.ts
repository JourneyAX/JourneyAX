import { connectToDatabase, COLLECTION_TURN_TRANSCRIPTS, TurnTranscriptRecord } from '@journeyax/database';
import { Collection, ClientSession } from 'mongodb';

export function redactPii(text: string): string {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/(Bearer\s+[a-zA-Z0-9_.-]{16,})/gi, '[REDACTED_SECRET]')
    .replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[REDACTED_CARD]')
    .replace(
      /(?:\+\d{1,3}[-.\s]+(?:\(?0?\d{1,4}\)?[-.\s]+)?\d{2,4}[-.\s]+\d{3,4}\b|\b0\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b|\(?\b0\d{1,3}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/g,
      '[REDACTED_PHONE]'
    );
}

export interface SaveTurnTranscriptInput {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  turnId: string;
  sessionId?: string;
  customerMessage: string;
  assistantReply: string;
  agentId?: string;
  timestamps: {
    receivedAt: string;
    completedAt: string;
  };
  retentionExpiresAt?: Date;
  metadata?: Record<string, unknown>;
  /** The turn's messages as typed blocks; text in them is redacted like the two strings are. */
  thread?: Array<Record<string, any>>;
}

/** The same redaction the two transcript strings get, applied to the text a thread keeps. */
export function redactThread(thread: Array<Record<string, any>> | undefined): Array<Record<string, any>> | undefined {
  if (!Array.isArray(thread)) return undefined;
  return thread.map((message) => ({
    ...message,
    blocks: (Array.isArray(message.blocks) ? message.blocks : []).map((block: any) => {
      if (block?.type === 'text') return { ...block, text: redactPii(String(block.text ?? '')) };
      if (block?.type === 'action' && typeof block.detail === 'string') return { ...block, detail: redactPii(block.detail) };
      return block;
    }),
  }));
}

export class TurnTranscriptStore {
  private col: Collection<TurnTranscriptRecord> | null = null;
  private tried = false;
  private memoryStore = new Map<string, TurnTranscriptRecord>();
  private readonly explicitMemory: boolean = false;

  constructor(customDbOrOptions?: any) {
    if (customDbOrOptions && typeof customDbOrOptions.collection === 'function') {
      this.col = customDbOrOptions.collection(COLLECTION_TURN_TRANSCRIPTS);
      this.tried = true;
    } else if (customDbOrOptions?.forceInMemory || customDbOrOptions?.explicitMemory) {
      this.col = null;
      this.tried = true;
      this.explicitMemory = true;
    }
  }

  private get allowMemoryFallback(): boolean {
    if (this.explicitMemory) return true;
    return process.env.NODE_ENV !== 'production' && process.env.ALLOW_IN_MEMORY_WORKSPACES !== 'false';
  }

  private memoryKey(tenantId: string, environmentId: string, workspaceId: string, turnId: string): string {
    return `${tenantId}:${environmentId}:${workspaceId}:${turnId}`;
  }

  private async getCol(): Promise<Collection<TurnTranscriptRecord> | null> {
    if (this.col) return this.col;
    if (this.tried) return null;
    this.tried = true;

    const uri = process.env.MONGODB_URI;
    if (!uri) {
      if (this.allowMemoryFallback) {
        return null;
      }
      throw new Error('[TurnTranscriptStore] MONGODB_URI is required in production.');
    }

    try {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<TurnTranscriptRecord>(COLLECTION_TURN_TRANSCRIPTS);
      return this.col;
    } catch {
      if (this.allowMemoryFallback) {
        return null;
      }
      throw new Error('[TurnTranscriptStore] Database unavailable in production.');
    }
  }

  async saveTurn(
    input: SaveTurnTranscriptInput,
    retentionDays?: number,
    session?: ClientSession
  ): Promise<TurnTranscriptRecord> {
    const days = retentionDays && retentionDays > 0 ? retentionDays : 90;
    const expiresAt = input.retentionExpiresAt || new Date(Date.now() + days * 86400000);

    const record: TurnTranscriptRecord = {
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      sessionId: input.sessionId,
      customerMessage: redactPii(input.customerMessage),
      assistantReply: redactPii(input.assistantReply),
      agentId: input.agentId,
      timestamps: input.timestamps,
      retentionExpiresAt: expiresAt,
      metadata: input.metadata,
      ...(input.thread ? { thread: redactThread(input.thread) } : {}),
      createdAt: new Date(),
    };

    const col = await this.getCol();
    if (!col) {
      this.memoryStore.set(
        this.memoryKey(record.tenantId, record.environmentId, record.workspaceId, record.turnId),
        record
      );
      return record;
    }

    await col.updateOne(
      {
        tenantId: record.tenantId,
        environmentId: record.environmentId,
        workspaceId: record.workspaceId,
        turnId: record.turnId,
      },
      { $set: record },
      { upsert: true, session }
    );

    return record;
  }

  async getRecentTurns(
    tenantId: string,
    environmentId: string,
    workspaceId: string,
    limit: number = 5
  ): Promise<TurnTranscriptRecord[]> {
    if (!tenantId || !workspaceId) return [];

    const col = await this.getCol();
    if (!col) {
      const prefix = `${tenantId}:${environmentId}:${workspaceId}:`;
      const matches: TurnTranscriptRecord[] = [];
      for (const [key, val] of this.memoryStore.entries()) {
        if (key.startsWith(prefix) && val.tenantId === tenantId) {
          matches.push(val);
        }
      }
      matches.sort((a, b) => a.timestamps.receivedAt.localeCompare(b.timestamps.receivedAt));
      return matches.slice(-limit);
    }

    const docs = await col
      .find({
        tenantId,
        environmentId,
        workspaceId,
      })
      .sort({ 'timestamps.receivedAt': 1 })
      .toArray();

    return docs.slice(-limit);
  }

  async getTranscript(
    tenantId: string,
    sessionIdOrWorkspaceId: string,
    environmentId?: string
  ): Promise<{
    tenantId: string;
    sessionId: string;
    messages: Array<{ role: string; content: string; timestamp: string }>;
    turnCount: number;
    found: boolean;
  }> {
    if (!tenantId || !sessionIdOrWorkspaceId) {
      return {
        tenantId,
        sessionId: sessionIdOrWorkspaceId,
        messages: [],
        turnCount: 0,
        found: false,
      };
    }

    const col = await this.getCol();
    let turns: TurnTranscriptRecord[] = [];

    if (!col) {
      for (const val of this.memoryStore.values()) {
        if (
          val.tenantId === tenantId &&
          (val.workspaceId === sessionIdOrWorkspaceId || val.sessionId === sessionIdOrWorkspaceId) &&
          (!environmentId || val.environmentId === environmentId)
        ) {
          turns.push(val);
        }
      }
      turns.sort((a, b) => a.timestamps.receivedAt.localeCompare(b.timestamps.receivedAt));
    } else {
      const filter: any = {
        tenantId,
        $or: [{ workspaceId: sessionIdOrWorkspaceId }, { sessionId: sessionIdOrWorkspaceId }],
      };
      if (environmentId) {
        filter.environmentId = environmentId;
      }
      turns = await col.find(filter).sort({ 'timestamps.receivedAt': 1 }).toArray();
    }

    if (turns.length === 0) {
      return {
        tenantId,
        sessionId: sessionIdOrWorkspaceId,
        messages: [],
        turnCount: 0,
        found: false,
      };
    }

    const messages = turns.flatMap((t) => [
      { role: 'user', content: t.customerMessage, timestamp: t.timestamps.receivedAt },
      { role: 'assistant', content: t.assistantReply, timestamp: t.timestamps.completedAt },
    ]);

    return {
      tenantId,
      sessionId: sessionIdOrWorkspaceId,
      messages,
      turnCount: turns.length,
      found: true,
    };
  }

  clearMemory(): void {
    this.memoryStore.clear();
  }
}
