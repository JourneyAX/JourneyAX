/**
 * Notices invoice exceptions. It asks the ERP, through the connector server, which invoices have been flagged as not matching what the customer
 * ordered or was sent since the last look. Nothing is written anywhere in the ERP. As in the other desks' intakes, the first look only sets the
 * starting point (now), so exceptions already in the ERP are never processed, and a cap on new cases per hour stops a flood from costing money.
 */
import type { CareEvents } from '../care.events';
import type { CareStore } from '../care.store';
import type { CareCase } from '../care.types';
import { toView } from '../care.view';
import type { ConnectorCaller } from '../connector-rpc';

export interface InvoicesIntakeDeps {
  store: CareStore;
  events: CareEvents;
  connectors: ConnectorCaller;
  now?: () => Date;
  /** The most new cases made in one hour. */
  maxPerHour?: number;
}

/** What the ERP says about one flagged invoice. */
export interface InvoiceExceptionRecord {
  exceptionId: number;
  invoiceId: string;
  raised?: string;
  updated?: string;
  status?: string;
  accountName: string;
  contactName?: string;
  contactEmail?: string;
  /** The customer's own words (an email forwarded to finance, or a note taken on a call). */
  message?: string;
  /** When an answer is due back to the customer (an ISO time). */
  respondBy?: string;
}

const OPEN = new Set(['open', 'new']);
export const INVOICES_ERP = 'ace-erp';

export class InvoicesIntake {
  constructor(private readonly d: InvoicesIntakeDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());

  /** Makes the case file for an exception and announces it at stage `arrived`. Returns it, or null when it was already known or must be left alone. */
  async ingest(tenantId: string, record: InvoiceExceptionRecord): Promise<CareCase | null> {
    const exceptionId = Number(record?.exceptionId);
    if (!exceptionId || !record.invoiceId || !record.accountName) return null;
    const id = `i${exceptionId}`;
    if (await this.d.store.get(tenantId, id)) return null;
    if (record.status && !OPEN.has(String(record.status))) return null;
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    if ((await this.d.store.createdSince(tenantId, hourAgo)) >= (this.d.maxPerHour ?? 20)) return null;
    const t = this.now(); const p = (n: number) => String(n).padStart(2, '0');
    const raised = String(record.raised || t.toISOString());
    const doc: CareCase = {
      tenantId, id, desk: 'invoices', ref: `IX-${exceptionId}`, zendeskId: exceptionId, zendeskUpdatedAt: String(record.updated || raised),
      subject: `Invoice ${record.invoiceId}: ${record.accountName} says it is wrong`.slice(0, 200), channel: 'Raised by SAP ERP',
      message: String(record.message || `${record.accountName} has queried invoice ${record.invoiceId}.`).slice(0, 1500),
      requester: { name: record.contactName, email: record.contactEmail }, createdAt: t.toISOString(), updatedAt: t.toISOString(),
      stage: 'arrived', status: 'ai', dueAt: record.respondBy ? new Date(Date.parse(record.respondBy)).toISOString() : new Date(t.getTime() + 4 * 3_600_000).toISOString(),
      assignee: { name: 'Unassigned', id: '' }, customer: { name: record.contactName || record.accountName, account: record.contactName ? record.accountName : 'Trade account', since: '', earlier: `Invoice ${record.invoiceId}` },
      topic: { value: '', confidence: 'Low' }, mood: { value: '', confidence: 'Low' }, found: [], notChecked: [], summary: '', recommendation: '', otherOption: '',
      draft: { isReply: true, text: '', original: '' }, replyChecks: [], steps: [], needsLead: false,
      timeline: [{ stage: 'arrived', at: `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`, note: `Invoice exception ${exceptionId} raised by SAP ERP for invoice ${record.invoiceId}.` }],
    };
    // What the ERP raised is kept on the case, so the later stages work from the invoice's own number and not from the words of the message.
    doc.raw = { ...record };
    await this.d.store.save(doc);
    this.d.events.emit(tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
    return doc;
  }

  /** One look at the ERP. Returns the cases it made, oldest first. */
  async poll(tenantId: string): Promise<CareCase[]> {
    const cursor = await this.d.store.getCursor(tenantId);
    if (!cursor) { await this.d.store.setCursor(tenantId, this.now().toISOString()); return []; }
    const answer = await this.d.connectors.call(INVOICES_ERP, 'list_invoice_exceptions', { since: cursor, limit: 25 }, tenantId);
    const records: InvoiceExceptionRecord[] = (Array.isArray(answer?.records) ? answer.records : []).slice().sort((a: InvoiceExceptionRecord, b: InvoiceExceptionRecord) => String(a.updated).localeCompare(String(b.updated)));
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
