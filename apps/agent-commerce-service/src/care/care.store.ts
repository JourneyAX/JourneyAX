/**
 * Where the case files live. `MemoryCareStore` is for tests and for a scratch copy with no database; `MongoCareStore` is the real one. Both keep
 * the same promises: one case file per ticket per tenant, and a saved case is never replaced by an older version of itself.
 */
import type { Collection, Db } from 'mongodb';
import { stageRank, type CareCase } from './care.types';

export interface CareStore {
  get(tenantId: string, id: string): Promise<CareCase | null>;
  list(tenantId: string): Promise<CareCase[]>;
  save(doc: CareCase): Promise<void>;
  /** Takes the ticket for this worker. True for exactly one caller, once: how two copies of the service avoid working the same ticket. */
  claim(tenantId: string, id: string, at: string): Promise<boolean>;
  getCursor(tenantId: string): Promise<string | null>;
  setCursor(tenantId: string, iso: string): Promise<void>;
  createdSince(tenantId: string, iso: string): Promise<number>;
}

/** A saved case does not go back a stage: a slow worker finishing late must not undo what a person already decided. */
const newerOrEqual = (next: CareCase, current: CareCase | null): boolean => !current || stageRank(next.stage) >= stageRank(current.stage);

export class MemoryCareStore implements CareStore {
  private docs = new Map<string, CareCase>();
  private cursors = new Map<string, string>();
  private key = (tenantId: string, id: string) => `${tenantId}::${id}`;
  async get(tenantId: string, id: string) { const d = this.docs.get(this.key(tenantId, id)); return d ? structuredClone(d) : null; }
  async list(tenantId: string) { return [...this.docs.values()].filter((d) => d.tenantId === tenantId).map((d) => structuredClone(d)); }
  async save(doc: CareCase) {
    if (!newerOrEqual(doc, this.docs.get(this.key(doc.tenantId, doc.id)) ?? null)) return;
    this.docs.set(this.key(doc.tenantId, doc.id), structuredClone(doc));
  }
  async claim(tenantId: string, id: string, at: string) {
    const doc = this.docs.get(this.key(tenantId, id));
    if (!doc || doc.claimedAt) return false;
    doc.claimedAt = at;
    return true;
  }
  async getCursor(tenantId: string) { return this.cursors.get(tenantId) ?? null; }
  async setCursor(tenantId: string, iso: string) { this.cursors.set(tenantId, iso); }
  async createdSince(tenantId: string, iso: string) { return [...this.docs.values()].filter((d) => d.tenantId === tenantId && d.createdAt > iso).length; }
}

export class MongoCareStore implements CareStore {
  private cases: Collection<CareCase> | null = null;
  private state: Collection<{ tenantId: string; cursor: string }> | null = null;
  /** `prefix` names the collections (`care_cases` and `care_state` for customer care; the stock desk keeps its own). */
  constructor(private readonly getDb: () => Promise<Db | null>, private readonly prefix: string = 'care') {}
  private async open() {
    if (this.cases && this.state) return;
    const db = await this.getDb();
    if (!db) throw new Error('The database is not connected.');
    this.cases = db.collection<CareCase>(`${this.prefix}_cases`);
    this.state = db.collection(`${this.prefix}_state`);
    await Promise.all([this.cases.createIndex({ tenantId: 1, id: 1 }, { unique: true }), this.cases.createIndex({ tenantId: 1, createdAt: 1 }), this.state.createIndex({ tenantId: 1 }, { unique: true })]);
  }
  async get(tenantId: string, id: string) { await this.open(); return (await this.cases!.findOne({ tenantId, id }, { projection: { _id: 0 } })) as CareCase | null; }
  async list(tenantId: string) { await this.open(); return (await this.cases!.find({ tenantId }, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(200).toArray()) as CareCase[]; }
  async save(doc: CareCase) {
    await this.open();
    const current = await this.get(doc.tenantId, doc.id);
    if (!newerOrEqual(doc, current)) return;
    await this.cases!.replaceOne({ tenantId: doc.tenantId, id: doc.id }, doc, { upsert: true });
  }
  async claim(tenantId: string, id: string, at: string) {
    await this.open();
    const taken = await this.cases!.findOneAndUpdate({ tenantId, id, claimedAt: { $exists: false } }, { $set: { claimedAt: at } });
    return !!taken;
  }
  async getCursor(tenantId: string) { await this.open(); return (await this.state!.findOne({ tenantId }))?.cursor ?? null; }
  async setCursor(tenantId: string, iso: string) { await this.open(); await this.state!.updateOne({ tenantId }, { $set: { cursor: iso } }, { upsert: true }); }
  async createdSince(tenantId: string, iso: string) { await this.open(); return this.cases!.countDocuments({ tenantId, createdAt: { $gt: iso } }); }
}
