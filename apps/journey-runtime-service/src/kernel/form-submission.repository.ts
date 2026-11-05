import { randomBytes } from 'node:crypto';
import type { Collection } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';

export const COLLECTION_FORM_SUBMISSIONS = 'form_submissions';

export interface FormSubmissionRecord {
  tenantId: string;
  environmentId: string;
  /** What the person is given and the shop quotes: short, unambiguous, like "FS-7K2M9Q". */
  reference: string;
  formId: string;
  formTitle: string;
  workspaceId: string;
  sessionId?: string;
  /** The signed-in person, or `anonymous`. */
  principalId: string;
  /** What was typed, checked against the form's definition; only declared fields. */
  values: Record<string, string | boolean>;
  /** Who reads it, as the shop worded it. */
  routeTo?: string;
  status: 'received';
  createdAt: Date;
}

/** A reference people can read out: no 0, O, 1, I or L. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newReference(bytes: Uint8Array = randomBytes(6)): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `FS-${out}`;
}

/**
 * Keeps what people send through the shop's forms. Every read and write names the tenant; a staff list only ever sees its own tenant's.
 * With no database (tests) submissions are held in memory. A submission is kept as sent: the shop's own flows, or the people who read
 * them, take it from there.
 */
export class FormSubmissionRepository {
  private col: Collection<FormSubmissionRecord> | null = null;
  private readonly inMemory: FormSubmissionRecord[] = [];

  constructor(private readonly dbOrProvider?: any) {
    if (dbOrProvider && typeof dbOrProvider.collection === 'function') this.col = dbOrProvider.collection(COLLECTION_FORM_SUBMISSIONS);
  }

  private async getCol(): Promise<Collection<FormSubmissionRecord> | null> {
    if (this.col) return this.col;
    if (this.dbOrProvider?.explicitMemory === true) return null;
    if (typeof this.dbOrProvider === 'function') {
      try {
        const resolved = await this.dbOrProvider();
        if (resolved && typeof resolved.collection === 'function') {
          this.col = resolved.collection(COLLECTION_FORM_SUBMISSIONS);
          return this.col;
        }
      } catch {
        // fall through to the connection URI
      }
    }
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    try {
      const { db } = await connectToDatabase(uri, process.env.FORM_SUBMISSIONS_DB_NAME || process.env.MONGODB_DB_NAME || 'journeyx');
      this.col = db.collection<FormSubmissionRecord>(COLLECTION_FORM_SUBMISSIONS);
      return this.col;
    } catch {
      return null;
    }
  }

  /** Keeps a submission. Throws when it cannot be kept: a person must never be told "sent" for a form that was lost. */
  async save(record: Omit<FormSubmissionRecord, 'reference' | 'status' | 'createdAt'> & { reference?: string }): Promise<FormSubmissionRecord> {
    const full: FormSubmissionRecord = { ...record, reference: record.reference || newReference(), status: 'received', createdAt: new Date() };
    const col = await this.getCol();
    if (!col) {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_IN_MEMORY_WORKSPACES !== 'true') throw new Error('[FormSubmissionRepository] no database to keep the submission in');
      this.inMemory.push(full);
      return full;
    }
    await col.insertOne({ ...full });
    return full;
  }

  /** The newest submissions of the tenant's forms, optionally one form's. */
  async list(tenantId: string, environmentId: string, options: { formId?: string; limit?: number } = {}): Promise<FormSubmissionRecord[]> {
    if (!tenantId) return [];
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const col = await this.getCol();
    const filter: Record<string, unknown> = { tenantId, environmentId, ...(options.formId ? { formId: options.formId } : {}) };
    if (!col) {
      return this.inMemory
        .filter((r) => r.tenantId === tenantId && r.environmentId === environmentId && (!options.formId || r.formId === options.formId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    }
    return (await col.find(filter, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray()) as FormSubmissionRecord[];
  }
}
