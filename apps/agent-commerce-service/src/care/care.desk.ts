/**
 * The care desk: what the portal asks for and does. It lists the tickets, takes a person's decision, carries out an approved list of changes
 * through the write-back, and keeps the case file honest about who decided what.
 *
 * Who may decide is settled here and never by the browser:
 *   - a care rep may approve a ticket assigned to them, unless it is held for the team lead;
 *   - the team lead (and an admin, acting as the lead) may approve any;
 *   - what is approved is exactly the draft and the steps the person sent, fingerprinted, and an approval is used once.
 */
import { createHash } from 'node:crypto';
import type { CareEvents } from './care.events';
import type { CareIntake } from './care.intake';
import type { CareProcessor } from './care.processor';
import { MOODS, TOPICS, type CareTeam } from './care.playbook';
import type { CareStore } from './care.store';
import type { CareWriteBack, CareActor } from './care.writeback';
import { stageRank, type CareCase, type CareTicketView } from './care.types';
import { toView } from './care.view';

export type Decision<T = {}> = ({ ok: true } & T) | { ok: false; code: 'not_found' | 'not_allowed' | 'not_ready' | 'invalid'; message: string };

export interface DeskDeps {
  store: CareStore;
  events: CareEvents;
  processor: CareProcessor;
  intake: CareIntake | null;
  writeBack: CareWriteBack;
  team: CareTeam;
  now?: () => Date;
  log?: (message: string) => void;
}

/** A ticket still marked "AI working" this long after its last change is finished from plain words and given to a person. */
const STUCK_MS = 120_000;

const hashOf = (draft: string, stepIds: string[]) => createHash('sha256').update(JSON.stringify({ draft, stepIds })).digest('hex');

export class CareDesk {
  private inFlight = new Set<Promise<unknown>>();
  constructor(private readonly d: DeskDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());
  private clock() { const t = this.now(); const p = (n: number) => String(n).padStart(2, '0'); return `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`; }

  /** The tickets, soonest promised time first. */
  async list(tenantId: string): Promise<CareTicketView[]> {
    const docs = await this.d.store.list(tenantId);
    return docs.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)).map((c) => toView(c, this.now().getTime()));
  }

  async get(tenantId: string, id: string): Promise<CareTicketView | null> {
    const doc = await this.d.store.get(tenantId, id);
    return doc ? toView(doc, this.now().getTime()) : null;
  }

  /** How many tickets are at each stage, for the whole team. */
  async board(tenantId: string): Promise<{ byStage: Record<string, number>; open: number; waitingOnAPerson: number; byPerson: Array<{ name: string; id: string; open: number }> }> {
    const docs = await this.d.store.list(tenantId);
    const byStage: Record<string, number> = {};
    for (const c of docs) byStage[c.stage] = (byStage[c.stage] ?? 0) + 1;
    const open = docs.filter((c) => c.stage !== 'done');
    const people = [...this.d.team.reps, { ...this.d.team.lead, skills: [] as string[] }];
    return { byStage, open: open.length, waitingOnAPerson: docs.filter((c) => c.stage === 'waiting').length, byPerson: people.map((p) => ({ name: p.name, id: p.id, open: open.filter((c) => c.assignee.id === p.id).length })) };
  }

  /** One look at the ticket desk; every ticket it finds is worked in the background. Returns how many it found. */
  async pollOnce(tenantId: string): Promise<number> {
    if (!this.d.intake) return 0;
    const made = await this.d.intake.poll(tenantId);
    for (const doc of made) this.work(tenantId, doc.id);
    await this.sweep(tenantId);
    return made.length;
  }

  /** Finds tickets the AI never finished (a worker that stopped part way, or one never started) and gets them to a person. */
  async sweep(tenantId: string): Promise<void> {
    for (const c of await this.d.store.list(tenantId)) {
      if (c.status !== 'ai' || this.now().getTime() - Date.parse(c.updatedAt) < STUCK_MS) continue;
      if (!c.claimedAt) this.work(tenantId, c.id);
      else {
        const job = this.d.processor.rescue(tenantId, c.id).catch((error) => this.d.log?.(`care: rescuing ${c.id} failed: ${String(error?.message || error)}`)).finally(() => { this.inFlight.delete(job); });
        this.inFlight.add(job);
      }
    }
  }

  /** Starts the AI's work on a case without making the caller wait for it. */
  work(tenantId: string, id: string): void {
    const job = this.d.processor.run(tenantId, id).catch((error) => this.d.log?.(`care: working ${id} failed: ${String(error?.message || error)}`)).finally(() => { this.inFlight.delete(job); });
    this.inFlight.add(job);
  }

  /** Resolves when every started piece of work has finished (used by tests and by a clean shutdown). */
  async idle(): Promise<void> { while (this.inFlight.size) await Promise.all([...this.inFlight]); }

  private mayDecide(doc: CareCase, actor: CareActor): Decision {
    if (actor.isLead) return { ok: true };
    if (doc.needsLead) return { ok: false, code: 'not_allowed', message: 'Only the team lead can decide this one.' };
    if (doc.assignee.id !== actor.id) return { ok: false, code: 'not_allowed', message: `This ticket is assigned to ${doc.assignee.name}.` };
    return { ok: true };
  }

  /**
   * Approves exactly the draft and the steps the person sent, then carries the steps out one by one, announcing each. A step that fails stops the
   * run: the ticket stays open at "changes running" with the reason, and `retry` carries on from that step.
   */
  async approve(tenantId: string, id: string, actor: CareActor, input: { draft?: unknown; removedSteps?: unknown; topic?: unknown; mood?: unknown }): Promise<Decision<{ ticket: CareTicketView; done: boolean }>> {
    const doc = await this.d.store.get(tenantId, id);
    if (!doc) return { ok: false, code: 'not_found', message: 'There is no such ticket.' };
    const allowed = this.mayDecide(doc, actor);
    if (allowed.ok === false) return allowed;
    if (doc.stage !== 'waiting') return { ok: false, code: 'not_ready', message: doc.stage === 'done' ? 'This ticket is already done.' : 'This ticket is not waiting for a decision.' };
    const draft = typeof input.draft === 'string' ? input.draft.trim() : doc.draft.text;
    if (doc.draft.isReply && draft.length < 5) return { ok: false, code: 'invalid', message: 'The reply is empty.' };
    const removed = Array.isArray(input.removedSteps) ? input.removedSteps.map(String) : [];
    if (removed.some((s) => !doc.steps.some((x) => x.id === s))) return { ok: false, code: 'invalid', message: 'One of the removed steps is not on this ticket.' };
    const kept = doc.steps.filter((s) => !removed.includes(s.id));
    if (!kept.length) return { ok: false, code: 'invalid', message: 'Every step was removed. Nothing would be approved.' };
    doc.draft = { ...doc.draft, text: draft };
    // Where the person disagreed with the AI's reading is kept, as the plainest signal of how well it is reading tickets.
    const corrections: NonNullable<CareCase['approval']>['corrections'] = {};
    if (typeof input.topic === 'string' && (TOPICS as readonly string[]).includes(input.topic) && input.topic !== doc.topic.value) { corrections.topic = { from: doc.topic.value, to: input.topic }; doc.topic = { value: input.topic, confidence: 'High' }; }
    if (typeof input.mood === 'string' && (MOODS as readonly string[]).includes(input.mood) && input.mood !== doc.mood.value) { corrections.mood = { from: doc.mood.value, to: input.mood }; doc.mood = { value: input.mood, confidence: 'High' }; }
    doc.approval = { by: { name: actor.name, id: actor.id }, at: this.now().toISOString(), contentHash: hashOf(draft, kept.map((s) => s.id)), edited: draft !== doc.draft.original, removedSteps: removed, ...(Object.keys(corrections).length ? { corrections } : {}), results: [] };
    doc.steps = kept;
    return this.run(doc, actor, 0, `Approved by ${actor.name} (${actor.id})${doc.approval.edited ? ', with edits' : ''}. Making the changes.`);
  }

  /** Carries on from the step that failed. Only the person who approved, or the lead, may do it. */
  async retry(tenantId: string, id: string, actor: CareActor): Promise<Decision<{ ticket: CareTicketView; done: boolean }>> {
    const doc = await this.d.store.get(tenantId, id);
    if (!doc) return { ok: false, code: 'not_found', message: 'There is no such ticket.' };
    if (doc.stage !== 'running' || !doc.approval) return { ok: false, code: 'not_ready', message: 'There is nothing to retry on this ticket.' };
    if (!actor.isLead && doc.approval.by.id !== actor.id) return { ok: false, code: 'not_allowed', message: `${doc.approval.by.name} approved this ticket.` };
    const from = doc.steps.findIndex((s) => !doc.approval!.results.some((r) => r.stepId === s.id && r.ok));
    return this.run(doc, actor, Math.max(from, 0), `Retrying from the change that did not go through.`);
  }

  private async run(doc: CareCase, actor: CareActor, from: number, note: string): Promise<Decision<{ ticket: CareTicketView; done: boolean }>> {
    const approval = doc.approval!;
    if (doc.stage !== 'running') { doc.stage = 'running'; doc.status = 'waiting'; doc.timeline.push({ stage: 'running', at: this.clock(), note }); } else doc.timeline.push({ stage: 'running', at: this.clock(), note });
    await this.save(doc);
    for (const step of doc.steps.slice(from)) {
      let result;
      try { result = await this.d.writeBack.run(doc.tenantId, doc, step, { draft: doc.draft.text, actor }); }
      catch (error: any) { result = { ok: false, message: String(error?.message || error).slice(0, 200) }; }
      approval.results = [...approval.results.filter((r) => r.stepId !== step.id), { stepId: step.id, ok: result.ok, message: result.message }];
      await this.save(doc);
      if (!result.ok) return { ok: true, ticket: toView(doc, this.now().getTime()), done: false };
    }
    doc.stage = 'done'; doc.status = 'done';
    doc.timeline.push({ stage: 'done', at: this.clock(), note: `Approved by ${approval.by.name}. All changes made.` });
    await this.save(doc);
    return { ok: true, ticket: toView(doc, this.now().getTime()), done: true };
  }

  async reject(tenantId: string, id: string, actor: CareActor): Promise<Decision<{ ticket: CareTicketView }>> {
    const doc = await this.d.store.get(tenantId, id);
    if (!doc) return { ok: false, code: 'not_found', message: 'There is no such ticket.' };
    const allowed = this.mayDecide(doc, actor);
    if (allowed.ok === false) return allowed;
    if (doc.stage !== 'waiting') return { ok: false, code: 'not_ready', message: 'This ticket is not waiting for a decision.' };
    doc.timeline.push({ stage: 'waiting', at: this.clock(), note: `${actor.name} did not approve it and will handle it. Nothing was changed.` });
    await this.save(doc);
    return { ok: true, ticket: toView(doc, this.now().getTime()) };
  }

  /** A rep hands a ticket up to the team lead. */
  async toLead(tenantId: string, id: string, actor: CareActor): Promise<Decision<{ ticket: CareTicketView }>> {
    const doc = await this.d.store.get(tenantId, id);
    if (!doc) return { ok: false, code: 'not_found', message: 'There is no such ticket.' };
    if (!actor.isLead && doc.assignee.id !== actor.id) return { ok: false, code: 'not_allowed', message: `This ticket is assigned to ${doc.assignee.name}.` };
    if (doc.stage !== 'waiting') return { ok: false, code: 'not_ready', message: 'This ticket is not waiting for a decision.' };
    doc.assignee = this.d.team.lead; doc.needsLead = true; doc.status = 'lead';
    doc.timeline.push({ stage: 'waiting', at: this.clock(), note: `${actor.name} sent it to ${this.d.team.lead.name} (${this.d.team.lead.id}).` });
    await this.save(doc);
    return { ok: true, ticket: toView(doc, this.now().getTime()) };
  }

  private async save(doc: CareCase) {
    doc.updatedAt = this.now().toISOString();
    await this.d.store.save(doc);
    this.d.events.emit(doc.tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
  }
}

export { stageRank };
