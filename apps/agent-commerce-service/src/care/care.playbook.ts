/**
 * The rules of the care desk that are not the model's to decide: who is on the team, which topics exist, what each topic asks for, who it goes to,
 * and which changes a ticket of that topic may propose. The AI reads the ticket and writes the words; this file decides what can be done.
 *
 * The team below is the one the care screens show. `CARE_TEAM` (JSON in the environment) replaces it for a real desk.
 */
import type { CareConfidence, CareStep } from './care.types';

export interface CarePerson { name: string; id: string; skills: string[]; /** The sign-in this person uses, so the portal knows who is asking. */ email?: string }
export interface CareTeam { reps: CarePerson[]; lead: { name: string; id: string } }

export const DEFAULT_TEAM: CareTeam = {
  reps: [
    { name: 'Aroha Ngata', id: 'CSR-1041', email: 'csr@placemakers.demo', skills: ['Delivery', 'Cancel order', 'Change of address', 'Product question'] },
    { name: 'Tane Walker', id: 'CSR-1042', skills: ['Damaged item', 'Wrong or missing item', 'Return or refund', 'Warranty'] },
    { name: 'Mei Lin Tan', id: 'CSR-1043', skills: ['Invoice'] },
  ],
  lead: { name: 'Hemi Parata', id: 'TL-2001' },
};

export function teamFromEnv(env: Record<string, string | undefined> = process.env): CareTeam {
  try {
    const parsed = JSON.parse(env.CARE_TEAM || 'null');
    if (parsed && Array.isArray(parsed.reps) && parsed.reps.length && parsed.lead?.id) return parsed as CareTeam;
  } catch { /* an unreadable setting means the default team */ }
  return DEFAULT_TEAM;
}

export const TOPICS = ['Delivery', 'Damaged item', 'Wrong or missing item', 'Cancel order', 'Change of address', 'Return or refund', 'Invoice', 'Warranty', 'Product question', 'Complaint'] as const;
export const MOODS = ['Very positive', 'Positive', 'Neutral', 'Frustrated', 'Upset', 'Angry'] as const;
export type CareTopic = (typeof TOPICS)[number];

/** The reading used when no model is available or its answer is unusable: plain words in the ticket. Always Medium or Low, never High. */
export function readByWords(subject: string, message: string): { topic: CareTopic; topicConfidence: CareConfidence; mood: string; moodConfidence: CareConfidence } {
  const text = `${subject} ${message}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  let topic: CareTopic = 'Product question';
  let sure = false;
  if (has('close my account', 'complaint', 'third time', 'unacceptable', 'disgrace', 'sick of')) { topic = 'Complaint'; sure = true; }
  else if (has('cancel')) { topic = 'Cancel order'; sure = true; }
  else if (has('crack', 'broken', 'damaged', 'smashed', 'dented', 'scratched')) { topic = 'Damaged item'; sure = true; }
  else if (has('wrong item', 'wrong size', 'wrong one', 'missing', 'not what i ordered', 'incorrect')) { topic = 'Wrong or missing item'; sure = true; }
  else if (has('refund', 'return')) { topic = 'Return or refund'; sure = true; }
  else if (has('invoice', 'statement', 'credit note')) { topic = 'Invoice'; sure = true; }
  else if (has('warranty', 'guarantee')) { topic = 'Warranty'; sure = true; }
  else if (has('change the address', 'change my address', 'different address', 'delivery address')) { topic = 'Change of address'; sure = true; }
  else if (has('not arrived', "hasn't arrived", 'has not arrived', 'where is', 'late', 'delivery', 'deliver', 'tracking', 'when will', 'when is')) { topic = 'Delivery'; sure = true; }
  let mood = 'Neutral';
  if (has('furious', 'angry', 'unacceptable', 'third time', 'disgrace', 'sick of')) mood = 'Angry';
  else if (has('not happy', 'disappointed', 'upset', 'annoyed')) mood = 'Upset';
  else if (has('nobody', 'still waiting', 'frustrat', 'no one has')) mood = 'Frustrated';
  else if (has('thank', 'great', 'happy with')) mood = 'Positive';
  return { topic, topicConfidence: sure ? 'Medium' : 'Low', mood, moodConfidence: 'Medium' };
}

/**
 * One way an order number looks in a customer's words. `pattern` (a regular expression, matched without regard to case) decides what counts, `example`
 * is shown to the model and must match its own pattern, or the format is ignored. `CARE_ORDER_FORMATS` (JSON) replaces the list below.
 */
export interface OrderFormat { name: string; pattern: string; example: string }

export const DEFAULT_ORDER_FORMATS: OrderFormat[] = [
  { name: 'Checkout number', pattern: '\\b(?=[0-9A-F]*[0-9])(?=[0-9A-F]*[A-F])[0-9A-F]{8}\\b', example: '0960C27F' },
  { name: 'Prefixed number', pattern: '\\b[A-Z]{2,5}(?:-[A-Z]{2,5}){0,2}-\\d{3,6}\\b', example: 'AB-CD-0001' },
];

const MAX_FORMATS = 8;
const MAX_PATTERN = 200;
const MAX_TEXT = 20_000;
const MAX_NUMBERS = 5;
const compiled = new Map<string, RegExp | null>();

/** The format as a global regular expression, or null when it is unusable: it does not compile, matches nothing at all, or does not match its own example. */
function compile(format: OrderFormat): RegExp | null {
  const key = `${format.pattern}\u0000${format.example}`;
  if (compiled.has(key)) return compiled.get(key) ?? null;
  let result: RegExp | null = null;
  try {
    if (format.pattern.length > 0 && format.pattern.length <= MAX_PATTERN) {
      const re = new RegExp(format.pattern, 'gi');
      const own = new RegExp(format.pattern, 'i').exec(format.example);
      if (!re.test('') && own && own[0].toUpperCase() === format.example.toUpperCase()) result = new RegExp(format.pattern, 'gi');
    }
  } catch { /* a pattern that does not compile is left out */ }
  compiled.set(key, result);
  return result;
}

/** The formats the desk recognises, from `CARE_ORDER_FORMATS` when it holds at least one usable format, else the default list. `problems` says what was left out and why. */
export function orderFormatsFromEnv(env: Record<string, string | undefined> = process.env): { formats: OrderFormat[]; problems: string[] } {
  const raw = (env.CARE_ORDER_FORMATS || '').trim();
  if (!raw) return { formats: DEFAULT_ORDER_FORMATS, problems: [] };
  const problems: string[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { formats: DEFAULT_ORDER_FORMATS, problems: ['CARE_ORDER_FORMATS is not readable JSON, so the default order formats are used.'] }; }
  const formats: OrderFormat[] = [];
  for (const item of Array.isArray(parsed) ? parsed.slice(0, MAX_FORMATS) : []) {
    const f = item as Partial<OrderFormat>;
    if (typeof f?.name === 'string' && typeof f.pattern === 'string' && typeof f.example === 'string' && compile(f as OrderFormat)) formats.push({ name: f.name, pattern: f.pattern, example: f.example });
    else problems.push(`The order format "${String((item as any)?.name ?? '?').slice(0, 40)}" was left out: it needs a name, a pattern that compiles, and an example that matches it.`);
  }
  if (!formats.length) return { formats: DEFAULT_ORDER_FORMATS, problems: [...problems, 'CARE_ORDER_FORMATS has no usable format, so the default order formats are used.'] };
  return { formats, problems };
}

/** What the model is told an order number looks like: the names and examples from the formats. */
export const describeOrderFormats = (formats: OrderFormat[]): string => formats.map((f) => `${f.name}, like ${f.example}`).join('; ');

/** The order numbers written in a text, in the order they appear, upper case, at most a few. Whether an order with that number exists is for the look-up to say. */
export function orderNumbersIn(text: string, formats: OrderFormat[] = DEFAULT_ORDER_FORMATS): string[] {
  const input = String(text || '').slice(0, MAX_TEXT);
  const hits: Array<{ at: number; value: string }> = [];
  for (const format of formats) {
    const re = compile(format);
    if (!re) continue;
    for (const m of input.matchAll(re)) hits.push({ at: m.index ?? 0, value: m[0].toUpperCase() });
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.value))].slice(0, MAX_NUMBERS);
}

/** What the desk records when it looked an order up and the system had no such order. The words are fixed so a reply can be checked against them. */
export const orderMissingNote = (ref: string): string => `Order ${ref} was not found in commercetools.`;
export const isOrderMissingNote = (note: string): boolean => /^Order .+ was not found in commercetools\.$/.test(note);

/** Who looks at it: the rep who has the topic and the fewest open tickets; the lead for what only a lead decides. */
export function assign(team: CareTeam, topic: string, openByPerson: Record<string, number>, needsLead: boolean): { name: string; id: string } {
  if (needsLead) return team.lead;
  const skilled = team.reps.filter((r) => r.skills.includes(topic));
  const pool = skilled.length ? skilled : team.reps;
  return [...pool].sort((a, b) => (openByPerson[a.id] ?? 0) - (openByPerson[b.id] ?? 0) || a.id.localeCompare(b.id))[0];
}

/** What the customer is told about the ticket after the reply goes out. */
const AFTER_STATUS: Partial<Record<CareTopic, string>> = { 'Cancel order': 'Solved', Invoice: 'Solved', 'Product question': 'Solved' };

/**
 * A check, in code, of whether an order can be cancelled or refunded: the "policy check" that sits between the AI and any money. It decides what may be
 * PROPOSED; a person still decides what happens. For faults the answer is always "a person": New Zealand's rules make the remedy depend on whether a
 * fault is minor or substantial, which the AI never decides.
 */
export interface RefundCheck { verdict: 'ok' | 'person' | 'no'; note: string; cancelAllowed: boolean }
export function refundCheck(order: { state?: string; shipment?: string; payment?: string; total?: number; currency?: string }, topic: string, limit: number): RefundCheck {
  const shipment = String(order.shipment || '').toLowerCase();
  const paid = String(order.payment || '').toLowerCase() === 'paid';
  const over = typeof order.total === 'number' && order.total > limit ? ` It is over the ${limit} a rep may decide, so the team lead decides.` : '';
  if (topic === 'Cancel order') {
    if (String(order.state || '').toLowerCase() === 'cancelled') return { verdict: 'no', note: 'The order is already cancelled.', cancelAllowed: false };
    if (['shipped', 'delivered', 'partial'].includes(shipment)) return { verdict: 'no', note: 'The order has already been dispatched, so it cannot be cancelled. It becomes a return, which a person decides.', cancelAllowed: false };
    if (shipment === 'ready') return { verdict: 'person', note: `The order is picked and waiting. The branch has to stop it before it can be cancelled.${over}`, cancelAllowed: true };
    // An order the shop recorded has no shipment state, so nothing says whether it was dispatched: never state that it was not.
    if (!shipment || shipment === 'unknown') return { verdict: 'person', note: `No shipment is recorded for this order, so nothing here says whether it has been dispatched. The branch has to confirm that before it is cancelled.${over}`, cancelAllowed: true };
    if (!paid) return { verdict: 'person', note: 'Payment is not recorded as paid, so there may be nothing to refund.', cancelAllowed: true };
    return { verdict: 'ok', note: `The order has not been dispatched, so it can be cancelled and refunded.${over}`, cancelAllowed: true };
  }
  if (['Damaged item', 'Wrong or missing item', 'Return or refund', 'Warranty'].includes(topic)) return { verdict: 'person', note: `A person decides the remedy: it depends on the kind of fault, which only a person judges.${over}`, cancelAllowed: false };
  return { verdict: 'ok', note: 'No money is involved.', cancelAllowed: false };
}

export interface StepContext {
  ticketId: number;
  topic: string;
  customerName: string;
  orderRef?: string;
  orderTotal?: number;
  currency?: string;
  subject: string;
  message: string;
  repName: string;
  /** False when the order has already been dispatched: a cancellation is then not proposed. */
  cancelAllowed?: boolean;
}

/**
 * The changes a ticket of this topic may propose. Fixed here, never written by the model, so the list of what can happen is always one of a few
 * known actions. Each step names the tool the write-back will run.
 */
export function stepsFor(c: StepContext): CareStep[] {
  const steps: CareStep[] = [];
  const after = AFTER_STATUS[c.topic as CareTopic] ?? 'Pending';
  if (c.topic === 'Complaint') {
    steps.push({ id: 's1', system: 'Zendesk', kind: 'internal', what: 'Reassign the ticket to the team lead with an internal note', before: c.repName, after: 'Team lead', action: { tool: 'update_ticket', args: { ticketId: c.ticketId, assignToLead: true, note: 'Complaint: a person should call today. See the AI work-up.' } } });
    steps.push({ id: 's2', system: 'Salesforce', kind: 'record', what: 'Create a task for the account manager', after: `Call ${c.customerName} today`, action: { tool: 'create_task', args: { subject: `Call ${c.customerName} today`, description: c.subject } } });
    return steps;
  }
  steps.push({ id: 's1', system: 'Zendesk', kind: 'customer', what: 'Send the reply and set the ticket to', before: 'Open', after, action: { tool: 'reply_to_ticket', args: { ticketId: c.ticketId, status: after.toLowerCase() } } });
  if (c.orderRef) {
    if (c.topic === 'Cancel order' && c.cancelAllowed !== false) {
      const amount = c.orderTotal != null ? `${c.currency ?? ''} ${c.orderTotal.toFixed(2)}`.trim() : '';
      steps.push({ id: 's2', system: 'commercetools', kind: 'money', what: `Cancel order ${c.orderRef} and record the refund`, before: 'Open', after: amount ? `Cancelled · ${amount}` : 'Cancelled', action: { tool: 'cancel_order', args: { orderNumber: c.orderRef } } });
    } else {
      steps.push({ id: 's2', system: 'commercetools', kind: 'internal', what: `Add a note on order ${c.orderRef}`, after: `${c.topic} reported in ticket ${c.ticketId}`, action: { tool: 'add_order_note', args: { orderNumber: c.orderRef, note: `${c.topic} reported in ticket ${c.ticketId}. See the care work-up.` } } });
    }
  }
  steps.push({ id: 's3', system: 'Salesforce', kind: 'record', what: `Log a case for ${c.customerName}`, after: c.topic, action: { tool: 'create_case', args: { subject: `${c.topic}: ${c.subject}`.slice(0, 250), description: c.message.slice(0, 3500), priority: 'medium' } } });
  return steps;
}

/** The amount of money a set of steps moves, when a step names one. */
export const moneyOf = (steps: CareStep[], total?: number): number => (steps.some((s) => s.kind === 'money') && total != null ? total : 0);

/** The words each topic falls back to when the model cannot be used. */
export function fallbackWords(topic: string, customer: string, rep: string, order?: { ref: string; shipment: string }): { summary: string; recommendation: string; otherOption: string; reply: string } {
  const first = customer.split(/[ ,]/)[0] || 'there';
  const sign = `Ngā mihi,\n${rep.split(' ')[0]}`;
  const ref = order ? `order ${order.ref}` : 'your order';
  switch (topic) {
    case 'Delivery': return { summary: order ? `Order ${order.ref} shipment is ${order.shipment.toLowerCase()}.` : 'Asks where an order is.', recommendation: 'Check the carrier, then tell the customer a firm next step.', otherOption: 'Offer pick-up from the nearest branch.', reply: `Kia ora ${first},\n\nThank you for getting in touch about ${ref}. I am checking where it is with the carrier and will come back to you with a firm date.\n\n${sign}` };
    case 'Damaged item': return { summary: 'Reports a damaged item.', recommendation: 'Ask for a photo of the damage.', otherOption: 'Arrange the next step once the photo is in.', reply: `Kia ora ${first},\n\nI am sorry about the damage. Could you reply with a photo? As soon as I have it I will look at the next step with you.\n\n${sign}` };
    case 'Cancel order': return { summary: 'Asks to cancel an order.', recommendation: 'Cancel it if it has not been dispatched.', otherOption: 'Offer to change the order instead.', reply: `Kia ora ${first},\n\nThank you for letting us know. I am checking that ${ref} has not been dispatched and will confirm the cancellation shortly.\n\n${sign}` };
    case 'Complaint': return { summary: 'A complaint that needs a person.', recommendation: 'A person should call today.', otherOption: 'Offer a meeting with the account manager.', reply: `Call notes\n• Start with what went wrong.\n• Ask what would make the next few months work.` };
    default: return { summary: `A ${topic.toLowerCase()} ticket.`, recommendation: 'Read it and reply with the facts from our systems.', otherOption: 'Hand it to someone with the right skills.', reply: `Kia ora ${first},\n\nThank you for your message. I am looking into it and will get back to you.\n\n${sign}` };
  }
}
