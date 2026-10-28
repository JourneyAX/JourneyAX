/**
 * Notices stock exceptions. It asks the ERP, through the connector server, which order lines could not be filled since the last look. Nothing is
 * written anywhere in the ERP. As in the care desk's intake, the first look only sets the starting point (now), so exceptions already in the ERP are
 * never processed, and a cap on new cases per hour stops a flood from costing money.
 */
import type { CareEvents } from '../care.events';
import type { CareStore } from '../care.store';
import type { CareCase } from '../care.types';
import { toView } from '../care.view';
import type { ConnectorCaller } from '../connector-rpc';

export interface StockIntakeDeps {
  store: CareStore;
  events: CareEvents;
  connectors: ConnectorCaller;
  now?: () => Date;
  /** The most new cases made in one hour. */
  maxPerHour?: number;
}

/** What the ERP says about one order line it could not fill. */
export interface ErpException {
  exceptionId: number;
  raised?: string;
  updated?: string;
  status?: string;
  branchCode: string;
  branchName: string;
  sku: string;
  productName: string;
  orderNumber?: string;
  customerName?: string;
  customerAccount?: string;
  needed: number;
  onHand: number;
  /** When the truck must leave to meet the order (an ISO time). */
  dispatchBy?: string;
  /** The day the order must be at the branch (YYYY-MM-DD). */
  neededBy?: string;
  note?: string;
}

const OPEN = new Set(['open', 'new']);
export const STOCK_ERP = 'ace-erp';

export class StockIntake {
  constructor(private readonly d: StockIntakeDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());

  /** Makes the case file for an exception and announces it at stage `arrived`. Returns it, or null when it was already known or must be left alone. */
  async ingest(tenantId: string, record: ErpException): Promise<CareCase | null> {
    const exceptionId = Number(record?.exceptionId);
    if (!exceptionId || !record.sku || !record.branchCode) return null;
    const id = `x${exceptionId}`;
    if (await this.d.store.get(tenantId, id)) return null;
    if (record.status && !OPEN.has(String(record.status))) return null;
    const hourAgo = new Date(this.now().getTime() - 3_600_000).toISOString();
    if ((await this.d.store.createdSince(tenantId, hourAgo)) >= (this.d.maxPerHour ?? 20)) return null;
    const needed = Number(record.needed) || 0; const onHand = Number(record.onHand) || 0;
    const short = Math.max(needed - onHand, 0);
    const order = record.orderNumber ? ` for order ${record.orderNumber}` : '';
    const t = this.now(); const p = (n: number) => String(n).padStart(2, '0');
    const raised = String(record.raised || t.toISOString());
    const customer = String(record.customerName || 'Customer');
    const doc: CareCase = {
      tenantId, id, desk: 'stock', ref: `EX-${exceptionId}`, zendeskId: exceptionId, zendeskUpdatedAt: String(record.updated || raised),
      subject: `${short} short: ${String(record.productName || record.sku).slice(0, 80)}${order}`.slice(0, 200), channel: 'Raised by SAP ERP',
      message: [`${record.branchName} cannot fill ${record.orderNumber ? `order ${record.orderNumber}` : 'an order line'}: ${needed} × ${record.productName || record.sku} needed, ${onHand} on hand.`, record.note ? String(record.note) : ''].filter(Boolean).join('\n\n').slice(0, 1500),
      requester: { name: customer }, createdAt: t.toISOString(), updatedAt: t.toISOString(),
      stage: 'arrived', status: 'ai', dueAt: record.dispatchBy ? new Date(Date.parse(record.dispatchBy)).toISOString() : new Date(t.getTime() + 4 * 3_600_000).toISOString(),
      assignee: { name: 'Unassigned', id: '' }, customer: { name: customer, account: String(record.customerAccount || 'Customer'), since: '', earlier: record.branchName },
      topic: { value: '', confidence: 'Low' }, mood: { value: '', confidence: 'Low' }, found: [], notChecked: [], summary: '', recommendation: '', otherOption: '',
      draft: { isReply: false, text: '', original: '' }, replyChecks: [], steps: [], needsLead: false,
      timeline: [{ stage: 'arrived', at: `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`, note: `Exception ${exceptionId} raised by SAP ERP at ${record.branchName}.` }],
    };
    // The facts the ERP gave are kept on the case, so the later stages work from what was raised and not from the words of the message.
    doc.raw = { ...record };
    await this.d.store.save(doc);
    this.d.events.emit(tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
    return doc;
  }

  /** One look at the ERP. Returns the cases it made, oldest first. */
  async poll(tenantId: string): Promise<CareCase[]> {
    const cursor = await this.d.store.getCursor(tenantId);
    if (!cursor) { await this.d.store.setCursor(tenantId, this.now().toISOString()); return []; }
    const answer = await this.d.connectors.call(STOCK_ERP, 'list_stock_exceptions', { since: cursor, limit: 25 }, tenantId);
    const records: ErpException[] = (Array.isArray(answer?.records) ? answer.records : []).slice().sort((a: ErpException, b: ErpException) => String(a.updated).localeCompare(String(b.updated)));
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
