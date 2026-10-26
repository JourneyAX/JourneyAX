/**
 * Notices tickets that reach the ticket desk. It asks Zendesk, through the connector server, what changed since the last look. Nothing is
 * written anywhere in Zendesk. The first look only sets the starting point (now), so the history already in Zendesk is never processed; a
 * cap on new cases per hour stops a flood from costing money. A webhook can feed `ingest` later, which is the same door.
 */
import type { CareEvents } from './care.events';
import type { ConnectorCaller } from './connector-rpc';
import type { CareStore } from './care.store';
import type { CareCase } from './care.types';
import { toView } from './care.view';

export interface IntakeDeps {
  store: CareStore;
  events: CareEvents;
  connectors: ConnectorCaller;
  now?: () => Date;
  /** The most new cases made in one hour. */
  maxPerHour?: number;
  /** Minutes from the ticket's creation to the promised first reply. */
  firstReplyMinutes?: number;
}

const LIVE = new Set(['new', 'open', 'pending', 'hold']);

export class CareIntake {
  constructor(private readonly d: IntakeDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());

  /** Makes the case file for a ticket and announces it at stage `arrived`. Returns it, or null when it was already known or must be left alone. */
  async ingest(tenantId: string, ticket: any): Promise<CareCase | null> {
    const zendeskId = Number(ticket?.ticketId);
    if (!zendeskId) return null;
    const id = `t${zendeskId}`;
    const existing = await this.d.store.get(tenantId, id);
    if (existing) return null;
    if (!LIVE.has(String(ticket.status))) return null;
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    if ((await this.d.store.createdSince(tenantId, hourAgo)) >= (this.d.maxPerHour ?? 20)) return null;
    const created = String(ticket.created || this.now().toISOString());
    const requester = typeof ticket.requester === 'object' && ticket.requester ? ticket.requester : {};
    const name = String(requester.name || String(requester.email || '').split('@')[0] || 'Customer');
    const p = (n: number) => String(n).padStart(2, '0');
    const t = this.now();
    const doc: CareCase = {
      tenantId, id, ref: String(zendeskId), zendeskId, zendeskUpdatedAt: String(ticket.updated || created),
      subject: String(ticket.subject || '(no subject)').slice(0, 200), channel: channelName(ticket.via), message: String(ticket.description || ticket.summary || '').slice(0, 1500),
      requester: { name: requester.name, email: requester.email }, createdAt: this.now().toISOString(), updatedAt: this.now().toISOString(),
      stage: 'arrived', status: 'ai', dueAt: new Date(Date.parse(created) + (this.d.firstReplyMinutes ?? 240) * 60_000).toISOString(),
      assignee: { name: 'Unassigned', id: '' }, customer: { name, account: 'Customer', since: '', earlier: '' },
      topic: { value: '', confidence: 'Low' }, mood: { value: '', confidence: 'Low' }, found: [], notChecked: [], summary: '', recommendation: '', otherOption: '',
      draft: { isReply: true, text: '', original: '' }, replyChecks: [], steps: [], needsLead: false,
      timeline: [{ stage: 'arrived', at: `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`, note: `Ticket ${zendeskId} reached Zendesk (${channelName(ticket.via)}).` }],
    };
    await this.d.store.save(doc);
    this.d.events.emit(tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
    return doc;
  }

  /** One look at Zendesk. Returns the cases it made, oldest first. */
  async poll(tenantId: string): Promise<CareCase[]> {
    const cursor = await this.d.store.getCursor(tenantId);
    if (!cursor) { await this.d.store.setCursor(tenantId, this.now().toISOString()); return []; }
    const answer = await this.d.connectors.call('zendesk', 'list_recent_tickets', { since: cursor, limit: 25 }, tenantId);
    const records: any[] = (Array.isArray(answer?.records) ? answer.records : []).slice().sort((a: any, b: any) => String(a.updated).localeCompare(String(b.updated)));
    const made: CareCase[] = [];
    for (const record of records) {
      const doc = await this.ingest(tenantId, record);
      if (doc) made.push(doc);
    }
    const newest = records.reduce((m: string, r: any) => (String(r.updated) > m ? String(r.updated) : m), cursor);
    if (newest > cursor) await this.d.store.setCursor(tenantId, newest);
    return made;
  }
}

function channelName(via: unknown): string {
  const v = String(via || '').toLowerCase();
  if (v === 'email') return 'Email';
  if (v === 'web' || v === 'web_form' || v === 'api') return 'Contact form';
  if (v === 'chat' || v === 'native_messaging') return 'Chat hand-over';
  return v ? v[0].toUpperCase() + v.slice(1) : 'Contact form';
}
