import { createHash, randomUUID } from 'node:crypto';
import type { OperationalDesk } from '@journeyax/business-pack';

export type IntakePolicy = NonNullable<NonNullable<OperationalDesk['preparation']>['intake']>;
export interface CaseScope { tenantId: string; environmentId: string; deskId: string; releaseChecksum: string }
export interface CaseAssessment { summary: string; proposals: Array<{ connector: string; tool: string; arguments: Record<string, unknown> }> }
export interface IntakeCase extends CaseScope {
  _id: string; recordId: string; sourceUpdatedAt: string;
  status: 'queued' | 'researching' | 'ready' | 'waiting_for_approval' | 'failed';
  attempts: number; summary?: string; proposals?: CaseAssessment['proposals'];
  expiresAt: Date; lease?: string; leaseUntil?: Date;
  progress?: { summary: string; actions: unknown[] };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const intakeActorId = (deskId: string) => `automation:desk-intake:${deskId}`;

/** One shared case per source revision, not one model run per viewer. No vendor writes live here. */
export class CaseIntakeStore {
  private indexSetup?: Promise<void>;
  constructor(private readonly database: () => Promise<any>, private readonly now = () => new Date()) {}
  private async collections() {
    const db = await this.database(); if (!db) throw new Error('Durable case intake storage is required.');
    return { jobs: db.collection('case_intake_jobs'), streams: db.collection('case_intake_streams'), attempts: db.collection('case_intake_attempts') };
  }
  ensureIndexes(): Promise<void> {
    return this.indexSetup ??= this.createIndexes().catch(error => { this.indexSetup = undefined; throw error; });
  }
  private async createIndexes() {
    const { jobs, attempts } = await this.collections();
    await jobs.createIndex({ tenantId: 1, environmentId: 1, deskId: 1, releaseChecksum: 1, status: 1, nextAttemptAt: 1 });
    await jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await attempts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await attempts.createIndex({ tenantId: 1, environmentId: 1, startedAt: 1 });
  }
  async enqueue(scope: CaseScope, recordId: string, sourceUpdatedAt: string, policy: IntakePolicy) {
    const { jobs } = await this.collections(); const at = this.now();
    const id = digest([scope.tenantId, scope.environmentId, scope.deskId, scope.releaseChecksum, recordId, sourceUpdatedAt]);
    try { await jobs.insertOne({ _id: id, ...scope, recordId, sourceUpdatedAt, status: 'queued', attempts: 0, createdAt: at, nextAttemptAt: at, expiresAt: new Date(at.getTime() + policy.resultTtlSeconds * 1000) }); }
    catch (error: any) { if (error?.code !== 11000) throw error; }
    return id;
  }
  async latest(scope: CaseScope, recordId: string, sourceUpdatedAt?: string): Promise<IntakeCase | undefined> {
    const { jobs } = await this.collections();
    return (await jobs.find({ ...scope, recordId, ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}), expiresAt: { $gt: this.now() } }).sort({ sourceUpdatedAt: -1, createdAt: -1 }).limit(1).toArray())[0];
  }
  async read(scope: CaseScope, caseId: string): Promise<IntakeCase | undefined> {
    if (!/^[a-f0-9]{64}$/.test(caseId)) return undefined;
    const { jobs } = await this.collections();
    return await jobs.findOne({ _id: caseId, ...scope, expiresAt: { $gt: this.now() } }) ?? undefined;
  }
  async claimReview(scope: CaseScope, caseId: string, principalId: string): Promise<boolean> {
    const { jobs } = await this.collections(); const at = this.now();
    const result = await jobs.findOneAndUpdate({ _id: caseId, ...scope, expiresAt: { $gt: at }, status: { $in: ['ready', 'waiting_for_approval'] }, $or: [{ reviewer: principalId }, { reviewUntil: { $exists: false } }, { reviewUntil: { $lt: at } }] }, { $set: { reviewer: principalId, reviewUntil: new Date(at.getTime() + 15 * 60_000) } }, { returnDocument: 'after' });
    return Boolean(result);
  }
  async recordProgress(scope: CaseScope, caseId: string, reviewer: string, progress: { summary: string; actions: unknown[] }): Promise<void> {
    const { jobs } = await this.collections();
    await jobs.updateOne({ _id: caseId, ...scope, reviewer, expiresAt: { $gt: this.now() } }, { $set: { progress: { summary: progress.summary.slice(0, 24_000), actions: progress.actions.slice(-40) }, activityUpdatedAt: this.now() } });
  }
  async claim(scope: CaseScope, policy: IntakePolicy): Promise<IntakeCase | undefined> {
    const { jobs, attempts } = await this.collections(); const at = this.now();
    const job = await jobs.findOneAndUpdate({ ...scope, expiresAt: { $gt: at }, attempts: { $lt: policy.maxAttempts }, $or: [{ status: 'queued', nextAttemptAt: { $lte: at } }, { status: 'researching', leaseUntil: { $lt: at } }] }, { $set: { status: 'researching', lease: randomUUID(), leaseUntil: new Date(at.getTime() + 120_000), startedAt: at }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { sourceUpdatedAt: 1 } });
    if (job) await attempts.insertOne({ _id: job.lease, ...scope, caseId: job._id, startedAt: at, expiresAt: new Date(at.getTime() + 7 * 86400_000) });
    return job ?? undefined;
  }
  async finish(job: IntakeCase, assessment: CaseAssessment) {
    if (!assessment.summary.trim() || assessment.summary.length > 24_000 || assessment.proposals.length > 5) throw new Error('The case assessment is incomplete or exceeds its review bound.');
    const { jobs } = await this.collections();
    const saved = await jobs.updateOne({ _id: job._id, tenantId: job.tenantId, environmentId: job.environmentId, lease: job.lease, status: 'researching' }, { $set: { ...assessment, status: assessment.proposals.length ? 'waiting_for_approval' : 'ready', completedAt: this.now() }, $unset: { lease: '', leaseUntil: '' } });
    if (!saved.matchedCount) throw new Error('The case lease changed; the stale result was discarded.');
  }
  async fail(job: IntakeCase, policy: IntakePolicy) {
    const { jobs } = await this.collections();
    await jobs.updateOne({ _id: job._id, tenantId: job.tenantId, environmentId: job.environmentId, lease: job.lease, status: 'researching' }, { $set: { status: job.attempts >= policy.maxAttempts ? 'failed' : 'queued', error: 'research_failed', nextAttemptAt: new Date(this.now().getTime() + Math.min(3600, 30 * 2 ** Math.max(0, job.attempts - 1)) * 1000) }, $unset: { lease: '', leaseUntil: '' } });
  }
  async heartbeat(job: IntakeCase) {
    const { jobs } = await this.collections();
    await jobs.updateOne({ _id: job._id, tenantId: job.tenantId, environmentId: job.environmentId, lease: job.lease, status: 'researching' }, { $set: { leaseUntil: new Date(this.now().getTime() + 120_000) } });
  }
  async withPoll(scope: CaseScope, policy: IntakePolicy, run: (checkpoint: any, save: (value: any) => Promise<void>, remaining: number) => Promise<void>): Promise<boolean> {
    const { jobs, attempts, streams } = await this.collections(); const at = this.now(); const id = digest(scope);
    await jobs.updateOne({ ...scope, status: 'researching', attempts: { $gte: policy.maxAttempts }, leaseUntil: { $lt: at } }, { $set: { status: 'failed', error: 'research_attempts_exhausted' }, $unset: { lease: '', leaseUntil: '' } });
    try { await streams.insertOne({ _id: id, ...scope, since: policy.startAt, nextPollAt: at }); } catch (error: any) { if (error?.code !== 11000) throw error; }
    const token = randomUUID();
    const stream = await streams.findOneAndUpdate({ _id: id, ...scope, nextPollAt: { $lte: at }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: at } }] }, { $set: { lease: token, leaseUntil: new Date(at.getTime() + 120_000) } }, { returnDocument: 'after' });
    if (!stream) return false;
    // A release promotion or a second desk must not reset or race the tenant's rolling hourly allowance.
    const quotaId = digest([scope.tenantId, scope.environmentId, 'research-quota']);
    try { await streams.insertOne({ _id: quotaId, tenantId: scope.tenantId, environmentId: scope.environmentId, kind: 'research-quota' }); } catch (error: any) { if (error?.code !== 11000) throw error; }
    const quota = await streams.findOneAndUpdate({ _id: quotaId, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: at } }] }, { $set: { lease: token, leaseUntil: new Date(at.getTime() + 120_000) } }, { returnDocument: 'after' });
    if (!quota) {
      await streams.updateOne({ _id: id, ...scope, lease: token }, { $unset: { lease: '', leaseUntil: '' } });
      return false;
    }
    const renew = setInterval(() => { for (const leaseId of [id, quotaId]) void streams.updateOne({ _id: leaseId, lease: token }, { $set: { leaseUntil: new Date(this.now().getTime() + 120_000) } }).catch(() => {}); }, 30_000);
    try {
      const count = await attempts.countDocuments({ tenantId: scope.tenantId, environmentId: scope.environmentId, startedAt: { $gte: new Date(at.getTime() - 3600_000) } });
      await run(stream, async value => {
        const quotaSaved = await streams.updateOne({ _id: quotaId, lease: token }, { $set: { leaseUntil: new Date(this.now().getTime() + 120_000) } });
        if (!quotaSaved.matchedCount) throw new Error('The intake allowance lease changed.');
        const saved = await streams.updateOne({ _id: id, ...scope, lease: token }, { $set: value });
        if (!saved.matchedCount) throw new Error('The intake checkpoint lease changed.');
      }, Math.max(0, policy.maxJobsPerHour - count));
    } finally {
      clearInterval(renew);
      await streams.updateOne({ _id: quotaId, lease: token }, { $unset: { lease: '', leaseUntil: '' } });
      await streams.updateOne({ _id: id, ...scope, lease: token }, { $set: { nextPollAt: new Date(this.now().getTime() + policy.pollSeconds * 1000) }, $unset: { lease: '', leaseUntil: '' } });
    }
    return true;
  }
}

/** Transport-independent ingestion. The same IQ read and the existing LLM harness are injected by the runtime. */
export class CaseIntakeProcessor {
  constructor(private readonly store: CaseIntakeStore) {}
  async tick(scope: CaseScope, policy: IntakePolicy, ports: {
    page(cursor?: string): Promise<any>;
    research(job: IntakeCase): Promise<CaseAssessment>;
  }) {
    if (!policy.enabled) return false;
    return this.store.withPoll(scope, policy, async (checkpoint, save, remaining) => {
      let cursor = typeof checkpoint.cursor === 'string' ? checkpoint.cursor : undefined; let highWater = checkpoint.highWater || checkpoint.since;
      // Bound source reads independently of model calls. Checkpoints move only after durable enqueue.
      for (let page = 0; page < policy.maxPagesPerPoll; page++) {
        const view = await ports.page(cursor);
        if (view?.ok !== true || !Array.isArray(view.records) || view.status === 'ambiguous' || view.status === 'partial' && !view.records.length && !view.page) throw new Error('Ticket intake source unavailable; checkpoint retained.');
        for (const record of view.records) {
          const updated = record.values?.[policy.updatedField]; const state = record.values?.[policy.statusField];
          if (typeof updated !== 'string' || !Number.isFinite(Date.parse(updated))) throw new Error('The intake revision field is unavailable.');
          if (Date.parse(updated) > Date.parse(highWater)) highWater = updated;
          if (Date.parse(updated) >= Date.parse(checkpoint.since) && Date.parse(updated) >= Date.parse(policy.startAt) && policy.statuses.includes(String(state)) && (!policy.recordIds || policy.recordIds.includes(record.canonicalId))) await this.store.enqueue(scope, record.canonicalId, updated, policy);
        }
        if (view.page?.more) {
          if (!view.page.nextCursor || view.page.nextCursor === cursor) throw new Error('Ticket paging did not advance; checkpoint retained.');
          cursor = view.page.nextCursor;
          await save({ cursor, highWater });
        } else { await save({ since: highWater, cursor: null, highWater: null }); break; }
      }
      for (let i = 0; i < Math.min(remaining, policy.maxJobsPerPoll); i++) {
        await save({ lastDispatchAt: new Date() }); // Fence a poller that lost its lease before another model call.
        const job = await this.store.claim(scope, policy); if (!job) break;
        const renew = setInterval(() => { void this.store.heartbeat(job).catch(() => {}); }, 30_000);
        try { await this.store.finish(job, await ports.research(job)); }
        catch { await this.store.fail(job, policy); }
        finally { clearInterval(renew); }
      }
    });
  }
}
