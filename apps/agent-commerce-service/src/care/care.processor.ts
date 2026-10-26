/**
 * The AI's work on one ticket, stage by stage. Each stage is saved and announced the moment it finishes, so a portal that is open shows the work
 * as it happens:
 *
 *   read        what the ticket is about, the mood, any order number           (one model call, or plain words if no model)
 *   researched  the order in commercetools, earlier tickets in Zendesk         (read-only lookups)
 *   drafted     the summary, the recommendation, the reply                     (one model call, or plain words if no model)
 *   waiting     given to a named person, or to the team lead when only a lead may decide
 *
 * What the AI may NOT do here: send anything to a customer, change any system, or invent the list of changes (the playbook fixes those).
 * Every look-up that fails is said plainly in `notChecked`, never hidden.
 */
import type { CareEvents } from './care.events';
import { checkReply } from './care.checks';
import type { ConnectorCaller } from './connector-rpc';
import { MOODS, TOPICS, assign, fallbackWords, moneyOf, orderNumbersIn, readByWords, stepsFor, type CareTeam } from './care.playbook';
import type { CareStore } from './care.store';
import { stageRank, type CareCase, type CareConfidence, type CareFact, type CareOrder, type CareStage, type CareStatus } from './care.types';
import { toView } from './care.view';

export interface CareModel { json(system: string, user: string, tenantId?: string): Promise<any | null> }

export interface ProcessorDeps {
  store: CareStore;
  events: CareEvents;
  connectors: ConnectorCaller | null;
  model: CareModel | null;
  team: CareTeam;
  /** A refund or cancellation over this amount is decided by the team lead. */
  refundLimit: number;
  now?: () => Date;
  /** Keeps each stage on screen at least this long, so a person watching can follow it. Zero in tests. */
  minStageMs?: number;
}

const CONF: CareConfidence[] = ['High', 'Medium', 'Low'];
const asConf = (v: unknown, fallback: CareConfidence): CareConfidence => (CONF.includes(v as CareConfidence) ? (v as CareConfidence) : fallback);
const text = (v: unknown, max: number): string => String(v ?? '').replace(/\s+\n/g, '\n').trim().slice(0, max);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NEEDS_ORDER = new Set(['Delivery', 'Damaged item', 'Wrong or missing item', 'Cancel order', 'Change of address', 'Return or refund']);

export class CareProcessor {
  constructor(private readonly d: ProcessorDeps) {}
  private now = () => (this.d.now ? this.d.now() : new Date());
  private clock() { const t = this.now(); const p = (n: number) => String(n).padStart(2, '0'); return `${t.getHours()}:${p(t.getMinutes())}:${p(t.getSeconds())}`; }

  /** Saves the case at its new stage and tells every open portal. */
  private async move(doc: CareCase, stage: CareStage, status: CareStatus, note: string, patch: Partial<CareCase> = {}): Promise<void> {
    Object.assign(doc, patch);
    doc.stage = stage; doc.status = status; doc.updatedAt = this.now().toISOString();
    doc.timeline.push({ stage, at: this.clock(), note });
    await this.d.store.save(doc);
    this.d.events.emit(doc.tenantId, { type: 'ticket', ticket: toView(doc, this.now().getTime()) });
    if (this.d.minStageMs) await sleep(this.d.minStageMs);
  }

  /** Runs every AI stage for a case that has just arrived. A case that is already past `arrived` is left alone, so asking twice does nothing. */
  async run(tenantId: string, id: string): Promise<CareCase | null> {
    const doc = await this.d.store.get(tenantId, id);
    if (!doc || stageRank(doc.stage) > stageRank('arrived')) return doc;
    try {
      const reading = await this.read(doc);
      await this.move(doc, 'read', 'ai', `Read it: topic ${reading.topic.value.toLowerCase()}, mood ${reading.mood.value.toLowerCase()}${reading.orders[0] ? `, order ${reading.orders[0]} named` : ''}.`, { topic: reading.topic, mood: reading.mood });
      const research = await this.research(doc, reading.orders);
      const systems = [...new Set(research.found.map((f) => f.source.system))];
      await this.move(doc, 'researched', 'ai', `Looked in ${systems.length ? systems.join(', ') : 'the sources'}${research.notChecked.length ? `; ${research.notChecked.length} thing${research.notChecked.length === 1 ? '' : 's'} could not be checked` : ''}.`, { found: research.found, notChecked: research.notChecked, order: research.order, customer: research.customer });
      const drafted = await this.draft(doc, research.order, research.orderTotal, research.currency);
      await this.move(doc, 'drafted', 'ai', `Wrote a summary, ${drafted.isReply ? 'a reply' : 'call notes'} and ${drafted.steps.length} change${drafted.steps.length === 1 ? '' : 's'}.`, drafted.patch);
    } catch (error: any) {
      // Whatever failed, the person still gets the ticket, with what the AI has and a plain line saying it could not finish.
      const w = fallbackWords(doc.topic.value || 'Product question', doc.customer.name, doc.assignee.name);
      doc.notChecked.push(`The AI could not finish its work: ${text(error?.message || error, 160)}`);
      if (!doc.draft.text) { doc.draft = { isReply: doc.topic.value !== 'Complaint', text: w.reply, original: w.reply }; doc.summary = w.summary; doc.recommendation = w.recommendation; doc.otherOption = w.otherOption; }
      if (!doc.steps.length) doc.steps = stepsFor({ ticketId: doc.zendeskId, topic: doc.topic.value || 'Product question', customerName: doc.customer.name, subject: doc.subject, message: doc.message, repName: doc.assignee.name });
      doc.replyChecks = checkReply(doc.draft.text, { facts: doc.found.map((f) => f.text), steps: doc.steps, isReply: doc.draft.isReply });
      await this.move(doc, 'drafted', 'ai', 'The AI could not finish; what it has is here for you to complete.');
    }
    const needsLead = doc.needsLead;
    const open = Object.fromEntries(this.d.team.reps.map((r) => [r.id, 0]));
    for (const c of await this.d.store.list(tenantId)) if (c.status === 'decide' && open[c.assignee.id] !== undefined) open[c.assignee.id] += 1;
    const owner = assign(this.d.team, doc.topic.value, open, needsLead);
    doc.assignee = owner;
    await this.move(doc, 'waiting', needsLead ? 'lead' : 'decide', needsLead ? 'Held for the team lead: a complaint, an upset customer, money over the limit, or the AI is not sure.' : `Assigned to ${owner.name} (${owner.id}) to decide.`, { assignee: owner });
    return doc;
  }

  private async read(doc: CareCase) {
    const fallback = readByWords(doc.subject, doc.message);
    let topic: string = fallback.topic, mood: string = fallback.mood;
    let topicConfidence: CareConfidence = fallback.topicConfidence, moodConfidence: CareConfidence = fallback.moodConfidence;
    let orders = orderNumbersIn(`${doc.subject} ${doc.message}`);
    if (this.d.model) {
      const said = await this.d.model.json(
        `You read customer-care tickets for a New Zealand building-supplies retailer. Answer with JSON only: {"topic":..., "topicConfidence":..., "mood":..., "moodConfidence":..., "orderNumber":...}. topic is one of ${JSON.stringify(TOPICS)}. mood is one of ${JSON.stringify(MOODS)}. Confidence is High only when the customer says it plainly, else Medium or Low. orderNumber is an 8-character order number written in the message (letters A-F and digits), or null. Never guess an order number.`,
        `Subject: ${doc.subject}\n\nMessage:\n${doc.message}`,
        doc.tenantId,
      ).catch(() => null);
      if (said && (TOPICS as readonly string[]).includes(said.topic)) { topic = said.topic; topicConfidence = asConf(said.topicConfidence, 'Medium'); }
      if (said && (MOODS as readonly string[]).includes(said.mood)) { mood = said.mood; moodConfidence = asConf(said.moodConfidence, 'Medium'); }
      if (said?.orderNumber) orders = [...new Set([...orderNumbersIn(String(said.orderNumber)), ...orders])];
    }
    return { topic: { value: topic, confidence: topicConfidence }, mood: { value: mood, confidence: moodConfidence }, orders };
  }

  private async research(doc: CareCase, orders: string[]) {
    const found: CareFact[] = [];
    const notChecked: string[] = [];
    let order: CareOrder | undefined; let orderTotal: number | undefined; let currency: string | undefined;
    const customer = { ...doc.customer };
    const topic = doc.topic.value;
    const c = this.d.connectors;
    if (!c) { notChecked.push('The connector server is not connected, so no other system was looked at.'); return { found, notChecked, order, orderTotal, currency, customer }; }
    if (doc.requester.email) {
      try {
        const r = await c.call('zendesk', 'find_tickets', { requesterEmail: doc.requester.email, status: 'unsolved', limit: 6 }, doc.tenantId);
        const others = (Array.isArray(r?.records) ? r.records : []).filter((x: any) => Number(x.ticketId) !== doc.zendeskId);
        customer.earlier = others.length ? `${others.length} other open ticket${others.length === 1 ? '' : 's'}` : 'No other open tickets';
        if (others.length) found.push({ text: `${others.length} other open ticket${others.length === 1 ? '' : 's'} from this customer (${others.slice(0, 3).map((x: any) => `#${x.ticketId}`).join(', ')}).`, source: { system: 'Zendesk', label: 'Earlier tickets' } });
      } catch { notChecked.push('Earlier tickets could not be read from Zendesk.'); }
    }
    if (orders.length) {
      try {
        const r = await c.call('commercetools', 'get_order', { orderId: orders[0] }, doc.tenantId);
        const o = r?.record;
        if (!o) throw new Error('no record');
        currency = o.currency; orderTotal = typeof o.total === 'number' ? o.total : undefined;
        const lines = Array.isArray(o.lines) ? o.lines : [];
        order = {
          ref: String(o.orderNumber || orders[0]),
          states: { order: String(o.state || 'Unknown'), shipment: String(o.shipmentState || 'Unknown'), payment: String(o.paymentState || 'Unknown') },
          lines: lines.map((l: any) => ({ name: String(l.name || l.sku || 'Item'), quantity: Number(l.quantity) || 1 })),
          notes: [],
        };
        found.push({ text: `Order ${order.ref} is ${order.states.order.toLowerCase()}, shipment ${order.states.shipment.toLowerCase()}, payment ${order.states.payment.toLowerCase()}.`, source: { system: 'commercetools', label: `Order ${order.ref}` } });
        if (orderTotal != null) found.push({ text: `Order total ${orderTotal.toFixed(2)} ${currency ?? ''}${o.shipTo?.city ? `, delivering to ${o.shipTo.city}` : ''}.`.replace(' ,', ','), source: { system: 'commercetools', label: `Order ${order.ref}` } });
      } catch { notChecked.push(`Order ${orders[0]} was not found in commercetools.`); }
    } else if (NEEDS_ORDER.has(topic)) {
      notChecked.push('There is no order number in the message, so no order was looked at.');
    }
    return { found, notChecked, order, orderTotal, currency, customer };
  }

  private async draft(doc: CareCase, order?: CareOrder, orderTotal?: number, currency?: string) {
    const topic = doc.topic.value;
    const words = fallbackWords(topic, doc.customer.name, doc.assignee.name, order ? { ref: order.ref, shipment: order.states.shipment } : undefined);
    let { summary, recommendation, otherOption, reply } = words;
    if (this.d.model) {
      const facts = doc.found.map((f) => `- ${f.text} (${f.source.system})`).join('\n') || '- (nothing was found in the systems)';
      const said = await this.d.model.json(
        `You prepare a care person's work-up of a ticket for a New Zealand building-supplies retailer. Answer with JSON only: {"summary":..., "recommendation":..., "otherOption":..., "reply":...}. summary: under 14 words. recommendation and otherOption: one plain sentence each. reply: ${topic === 'Complaint' ? 'short call notes as bullet lines starting with "•", for a team lead. Nothing goes to the customer' : `the email to the customer, warm and short, starting "Kia ora <first name>," and ending "Ngā mihi," then the care person's first name (${doc.assignee.name.split(' ')[0]})`}. RULES: use only the facts given. Never promise a refund, a replacement, an amount, a compensation or a date that is not in the facts: a person decides those. Never say a fault is minor or major. If something is not in the facts, say it will be checked.`,
        `Ticket subject: ${doc.subject}\nCustomer message:\n${doc.message}\n\nTopic: ${topic}. Mood: ${doc.mood.value}.\nFacts from the systems:\n${facts}\nNot checked: ${doc.notChecked.join(' ') || 'nothing'}`,
        doc.tenantId,
      ).catch(() => null);
      if (said) {
        summary = text(said.summary, 140) || summary; recommendation = text(said.recommendation, 300) || recommendation;
        otherOption = text(said.otherOption, 300) || otherOption; reply = text(said.reply, 2500) || reply;
      }
    }
    const isReply = topic !== 'Complaint';
    const steps = stepsFor({ ticketId: doc.zendeskId, topic, customerName: doc.customer.name, orderRef: order?.ref, orderTotal, currency, subject: doc.subject, message: doc.message, repName: doc.assignee.name });
    const replyChecks = checkReply(reply, { facts: doc.found.map((f) => f.text), steps, isReply });
    const needsLead = topic === 'Complaint' || doc.mood.value === 'Angry' || doc.topic.confidence === 'Low' || moneyOf(steps, orderTotal) > this.d.refundLimit;
    return {
      isReply, steps,
      patch: { summary, recommendation, otherOption, draft: { isReply, text: reply, original: reply }, replyChecks, steps, needsLead } as Partial<CareCase>,
    };
  }
}
