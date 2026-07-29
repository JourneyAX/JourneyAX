import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';
import { Db, Collection } from 'mongodb';
import { randomUUID } from 'crypto';

/**
 * ArtworkService (AUG-16) — customer-supplied artwork and its approval.
 *
 * WHY THIS SHAPE: the platform never reproduces a school or club mark. Those are
 * trademarked and licensed, so artwork is supplied BY the customer, who is the
 * party entitled to use it. Everything here therefore records provenance and
 * authorisation, not just a file.
 *
 * Approval is a state machine because production is irreversible: nothing may be
 * printed against artwork that hasn't been explicitly approved by a human. The
 * agent can attach and present artwork; it can never approve it.
 *
 *   uploaded → proofed → approved → (locked for production)
 *                     ↘ changes-requested → proofed …
 *
 * projectId is the isolation key throughout (the platform contract).
 */

export type ArtworkStatus = 'uploaded' | 'proofed' | 'approved' | 'changes-requested' | 'rejected';

export interface ArtworkRecord {
  artworkId: string;
  projectId: string;
  sessionId?: string;
  /** The entity this artwork belongs to (team/club/school), when known. */
  entityKey?: string;
  entityName?: string;

  fileName: string;
  contentType?: string;
  sizeBytes?: number;
  /** Where the bytes live (project-scoped key in the artifact store). */
  storageKey: string;

  /** Who says they may use this mark — recorded, never assumed. */
  authorisation?: {
    /** e.g. 'customer-owns' | 'licensed' | 'school-authorised' */
    basis?: string;
    statedBy?: string;
    statedAt?: string;
  };

  placement?: { location?: string; widthMm?: number; notes?: string };
  colours?: { name?: string; hex?: string; pms?: string }[];

  status: ArtworkStatus;
  /** Every state change, with who and why — this is the audit trail production relies on. */
  history: { at: string; status: ArtworkStatus; by?: string; note?: string }[];
  createdAt: string;
  updatedAt: string;
}

const DB_NAME = 'journeyx';
const COLLECTION = 'artwork';

@Injectable()
export class ArtworkService {
  private db!: Db;
  private col!: Collection<ArtworkRecord>;

  private async collection(): Promise<Collection<ArtworkRecord>> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    const { db } = await connectToDatabase(uri, DB_NAME);
    this.db = db;
    this.col = db.collection<ArtworkRecord>(COLLECTION);
    await this.col.createIndex({ projectId: 1, artworkId: 1 }, { unique: true }).catch(() => {});
    await this.col.createIndex({ projectId: 1, sessionId: 1 }).catch(() => {});
    await this.col.createIndex({ projectId: 1, entityKey: 1 }).catch(() => {});
    return this.col;
  }

  /**
   * Register customer-supplied artwork. Takes a storage key rather than bytes —
   * the file is uploaded to project-scoped artifact storage separately, so large
   * uploads never travel through the agent turn.
   */
  async register(projectId: string, input: {
    fileName: string; storageKey: string; contentType?: string; sizeBytes?: number;
    sessionId?: string; entityKey?: string; entityName?: string;
    authorisationBasis?: string; statedBy?: string;
    placement?: ArtworkRecord['placement'];
    colours?: ArtworkRecord['colours'];
  }): Promise<{ ok: boolean; artworkId?: string; message: string }> {
    if (!input?.fileName || !input?.storageKey) {
      return { ok: false, message: 'fileName and storageKey are required.' };
    }
    const col = await this.collection();
    const now = new Date().toISOString();
    const artworkId = `art_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await col.insertOne({
      artworkId, projectId,
      sessionId: input.sessionId, entityKey: input.entityKey, entityName: input.entityName,
      fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      authorisation: input.authorisationBasis
        ? { basis: input.authorisationBasis, statedBy: input.statedBy, statedAt: now }
        : undefined,
      placement: input.placement, colours: input.colours,
      status: 'uploaded',
      history: [{ at: now, status: 'uploaded', by: input.statedBy, note: 'Customer-supplied artwork received.' }],
      createdAt: now, updatedAt: now,
    } as ArtworkRecord);

    return {
      ok: true, artworkId,
      message: input.authorisationBasis
        ? 'Artwork received. It must be proofed and approved before production.'
        : 'Artwork received. Ask the customer to confirm they are entitled to use this mark before proofing.',
    };
  }

  /**
   * Move artwork through the approval flow.
   *
   * `approved` is deliberately restricted to a human actor: an agent must never
   * approve its own proof, because approval is the gate on irreversible printing.
   */
  async setStatus(projectId: string, artworkId: string, status: ArtworkStatus, opts: {
    by?: string; note?: string; actor?: 'human' | 'agent';
  } = {}): Promise<{ ok: boolean; status?: ArtworkStatus; message: string }> {
    const col = await this.collection();
    const rec = await col.findOne({ projectId, artworkId });
    if (!rec) return { ok: false, message: `No artwork "${artworkId}" on this project.` };

    if (status === 'approved' && opts.actor !== 'human') {
      return {
        ok: false, status: rec.status,
        message: 'Approval requires the customer. Present the proof and ask them to approve it — an agent cannot approve artwork.',
      };
    }
    if (rec.status === 'approved' && status !== 'changes-requested') {
      return {
        ok: false, status: rec.status,
        message: 'This artwork is already approved and locked for production. Request changes to reopen it.',
      };
    }

    const now = new Date().toISOString();
    await col.updateOne(
      { projectId, artworkId },
      {
        $set: { status, updatedAt: now },
        $push: { history: { at: now, status, by: opts.by, note: opts.note } },
      },
    );
    return { ok: true, status, message: `Artwork is now "${status}".` };
  }

  /** Artwork for a session or entity, so the agent can show what's on file. */
  async list(projectId: string, filter: { sessionId?: string; entityKey?: string } = {}): Promise<{
    items: Partial<ArtworkRecord>[]; approvedCount: number;
  }> {
    const col = await this.collection();
    const q: any = { projectId };
    if (filter.sessionId) q.sessionId = filter.sessionId;
    if (filter.entityKey) q.entityKey = filter.entityKey;
    const items = await col
      .find(q, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();
    return { items, approvedCount: items.filter((i) => i.status === 'approved').length };
  }

  /**
   * The production gate. A quote for customised goods must not proceed unless the
   * artwork it depends on is approved — this is the check the order path calls.
   */
  async approvalGate(projectId: string, sessionId: string): Promise<{
    clear: boolean; approved: number; pending: number; reason?: string;
  }> {
    const col = await this.collection();
    const items = await col.find({ projectId, sessionId }, { projection: { status: 1 } }).toArray();
    if (!items.length) {
      return { clear: false, approved: 0, pending: 0, reason: 'No artwork has been supplied for this order yet.' };
    }
    const approved = items.filter((i) => i.status === 'approved').length;
    const pending = items.length - approved;
    return pending === 0
      ? { clear: true, approved, pending: 0 }
      : { clear: false, approved, pending, reason: `${pending} artwork item(s) still awaiting customer approval.` };
  }
}
