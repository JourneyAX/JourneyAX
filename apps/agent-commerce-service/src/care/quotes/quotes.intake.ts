/**
 * Notices quote requests. It asks Salesforce, through the connector server, which deals have had a quote asked for since the last look. Nothing is
 * written anywhere in Salesforce. As in the other desks' intakes, the first look only sets the starting point (now), so requests already in
 * Salesforce are never processed, and a cap on new cases per hour stops a flood from costing money.
 */
import type { CareEvents } from '../care.events';
import type { CareStore } from '../care.store';
import type { CareCase } from '../care.types';
import { toView } from '../care.view';
import type { ConnectorCaller } from '../connector-rpc';

export interface QuotesIntakeDeps {
  store: CareStore;
  events: CareEvents;
  connectors: ConnectorCaller;
  now?: () => Date;
  /** The most new cases made in one hour. */
  maxPerHour?: number;
}

/** What Salesforce says about one deal that needs a quote. */
export interface QuoteRequest {
  requestId: number;
  opportunityId: string;
  raised?: string;
  updated?: string;
  status?: string;
  accountName: string;
  contactName?: string;
  contactEmail?: string;
  branchCode: string;
  branchName: string;
  /** The day the customer needs the goods (YYYY-MM-DD). */
  neededBy?: string;
  /** The customer's own words. */
  message?: string;
  lines: Array<{ sku: string; name?: string; quantity: number }>;
  /** When the quote is due back to the customer (an ISO time). */
  respondBy?: string;
}

const OPEN = new Set(['open', 'new']);
export const QUOTES_CRM = 'salesforce';

export class QuotesIntake {
  constructor(private readonly d: QuotesIntakeDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());

  /** Makes the case file for a request and announces it at stage `arrived`. Returns it, or null when it was already known or must be left alone. */
  async ingest(tenantId: string, record: QuoteRequest): Promise<CareCase | null> {
    const requestId = Number(record?.requestId);
    if (!requestId || !record.accountName || !Array.isArray(record.lines) || !record.lines.length) return null;
    const id = `q${requestId}`;
    if (await this.d.store.get(tenantId, id)) return null;
    if (record.status && !OPEN.has(String(record.status))) return null;
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    if ((await this.d.store.createdSince(tenantId, hourAgo)) >= (this.d.maxPerHour ?? 20)) return null;
    const t = this.now(); const p = (n: number) => String(n).padStart(2, '0');
    const raised = String(record.raised || t.toISOString());
    const doc: CareCase = {
      tenantId, id, desk: 'quotes', ref: `QT-${requestId}`, zendeskId: requestId, zendeskUpdatedAt: String(record.updated || raised),
      subject: `Quote for ${record.accountName}: ${record.lines.length} product${record.lines.length === 1 ? '' : 's'}`.slice(0, 200), channel: 'Raised by Salesforce',
      message: String(record.message || `${record.accountName} asked for a quote on deal ${record.opportunityId}.`).slice(0, 1500),
      requester: { name: record.contactName, email: record.contactEmail }, createdAt: t.toISOString(), updatedAt: t.toISOString(),
      stage: 'arrived', status: 'ai', dueAt: record.respondBy ? new Date(Date.parse(record.respondBy)).toISOString() : new Date(t.getTime() + 4 * 3_600_000).toISOString(),
      assignee: { name: 'Unassigned', id: '' }, customer: { name: record.contactName || record.accountName, account: record.contactName ? record.accountName : 'Trade account', since: '', earlier: `Deal ${record.opportunityId}` },
      topic: { value: '', confidence: 'Low' }, mood: { value: '', confidence: 'Low' }, found: [], notChecked: [], summary: '', recommendation: '', otherOption: '',
      draft: { isReply: true, text: '', original: '' }, replyChecks: [], steps: [], needsLead: false,
      timeline: [{ stage: 'arrived', at: `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`, note: `Quote request ${requestId} raised by Salesforce for deal ${record.opportunityId}.` }],
    };
    // What Salesforce raised is kept on the case, so the later stages work from the deal's own lines and not from the words of the message.
    doc.raw = { ...record };
    await this.d.store.save(doc);
    this.d.events.emit(tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
    return doc;
  }

  /** One look at Salesforce. Returns the cases it made, oldest first. */
  async poll(tenantId: string): Promise<CareCase[]> {
    const cursor = await this.d.store.getCursor(tenantId);
    if (!cursor) { await this.d.store.setCursor(tenantId, this.now().toISOString()); return []; }
    const answer = await this.d.connectors.call(QUOTES_CRM, 'list_quote_requests', { since: cursor, limit: 25 }, tenantId);
    const records: QuoteRequest[] = (Array.isArray(answer?.records) ? answer.records : []).slice().sort((a: QuoteRequest, b: QuoteRequest) => String(a.updated).localeCompare(String(b.updated)));
    const made: CareCase[] = [];
    for (const record of records) {
      const doc = await this.ingest(tenantId, record);
      if (doc) made.push(doc);
    }
    const newest = records.reduce((m, r) => (String(r.updated) > m ? String(r.updated) : m), cursor);
    if (newest > cursor) await this.d.store.setCursor(tenantId, newest);
    return made;
  }
}
