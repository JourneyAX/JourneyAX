/**
 * What the customer-care canvases show: tickets, the AI's work-up of each, and the changes it proposes.
 *
 * The shapes below are what the canvases need and nothing more. For this first look the tickets come from `CARE_TICKETS` (a fixed list);
 * the connected version reads the same shapes from the ticket desk, the commerce system and the CRM through the gateway, so the
 * canvases do not change when the data does. Nothing in this file talks to a vendor.
 */

/** Where a ticket stands for the person looking at it. One word each, always shown with an icon and a colour. */
export type CareStatus = 'ai' | 'decide' | 'waiting' | 'done' | 'lead';

/**
 * Where a ticket is in the AI's work, from the moment it reaches the ticket desk to the moment it is solved. The portal shows these as
 * they happen. `arrived` to `drafted` are the AI's; `waiting` is a named person's; `running` and `done` are the approved changes.
 */
export type CareStage = 'arrived' | 'read' | 'researched' | 'drafted' | 'waiting' | 'running' | 'done';

export interface CareStageInfo { id: CareStage; word: string; doing: string }
export const CARE_STAGES: CareStageInfo[] = [
  { id: 'arrived', word: 'Arrived', doing: 'Reached the ticket desk. Waiting for the AI.' },
  { id: 'read', word: 'AI read it', doing: 'Reading what the customer wrote: topic, mood, any order number.' },
  { id: 'researched', word: 'AI researched', doing: 'Looking up the order, the account and earlier tickets.' },
  { id: 'drafted', word: 'Draft ready', doing: 'Writing the summary, the reply and the list of changes.' },
  { id: 'waiting', word: 'Waiting for approval', doing: 'With a named care person to approve, edit or reject.' },
  { id: 'running', word: 'Changes running', doing: 'Making the approved changes in each system.' },
  { id: 'done', word: 'Done', doing: 'Solved. Recorded with who approved it.' },
];
export const stageIndex = (stage: CareStage): number => CARE_STAGES.findIndex((s) => s.id === stage);

export interface CareTimelineEntry { stage: CareStage; at: string; note: string }

export type CareSystem = 'Zendesk' | 'commercetools' | 'Salesforce' | 'SAP ERP';

/** Which desk a case belongs to: customer care's tickets, the stock exceptions desk's exceptions, or the quotes desk's quote requests. The same screens draw all three. */
export type DeskKind = 'care' | 'stock' | 'quotes';

/** What a proposed change does, so the person can tell a note from an email to the customer from a money move. */
export type CareStepKind = 'customer' | 'internal' | 'record' | 'money';

export interface CareStep {
  id: string;
  system: CareSystem;
  kind: CareStepKind;
  /** What will happen, in plain words. */
  what: string;
  /** The value now and the value after, when the step changes a field. */
  before?: string;
  after?: string;
}

export interface CareSource { system: CareSystem; label: string }
export interface CareFact { text: string; source: CareSource }

export interface CareOrder {
  ref: string;
  /** Three separate states, each a word, as the commerce system keeps them. */
  states: { order: string; shipment: string; payment: string };
  promised?: string;
  actual?: string;
  lines: Array<{ name: string; quantity: number }>;
  notes: string[];
}

/** A stock exception's own facts, drawn as a table of branches. */
export interface StockDetail {
  product: { sku: string; name: string };
  short: { branch: string; needed: number; onHand: number };
  branches: Array<{ name: string; onHand: number; spare: number; role: 'short' | 'source' | 'other'; note?: string }>;
}

/** A quote the AI priced, drawn as a table of lines. */
export interface QuoteDetail {
  tier: string;
  validUntil?: string;
  branch: string;
  lines: Array<{ sku: string; name: string; quantity: number; unit: string; retailPrice: number; unitPrice: number; lineTotal: number; stock: string }>;
  subtotal: number;
  gst: number;
  total: number;
  discountPercent: number;
  /** The currency the ERP's prices are in ("NZD"). */
  currency?: string;
}

export interface CareTicket {
  id: string;
  /** Absent means a customer-care ticket. */
  desk?: DeskKind;
  /** Set on a stock exception: what is short, where, and what every branch holds. */
  stock?: StockDetail;
  /** Set on a quote request: the quote the AI priced. */
  quote?: QuoteDetail;
  ref: string;
  subject: string;
  status: CareStatus;
  channel: string;
  /** What the customer wrote, shortened. */
  message: string;
  customer: { name: string; account: string; since: string; earlier: string };
  assignee: { name: string; id: string };
  /** Minutes until the next promised time. Negative when late. */
  slaMinutes: number;
  topic: { value: string; confidence: 'High' | 'Medium' | 'Low' };
  mood: { value: string; confidence: 'High' | 'Medium' | 'Low' };
  found: CareFact[];
  /** What the AI could not check, said plainly. */
  notChecked: string[];
  recommendation: string;
  otherOption: string;
  order?: CareOrder;
  draft: { isReply: boolean; text: string };
  /** Checks run on the draft before the person sees it. */
  replyChecks: Array<{ label: string; ok: boolean }>;
  steps: CareStep[];
  /** Only a team lead may approve (a complaint, low confidence, or money over the rep's limit). */
  needsLead?: boolean;
  /** The one-line summary shown in the list. */
  summary: string;
  stage: CareStage;
  /** What happened at each stage, with the time, oldest first. */
  timeline: CareTimelineEntry[];
  /** Who approved, when, and how each change went (set once a person has approved). */
  approval?: { by: { name: string; id: string }; at: string; edited: boolean; removedSteps: string[]; corrections?: { topic?: { from: string; to: string }; mood?: { from: string; to: string } }; results: Array<{ stepId: string; ok: boolean; message?: string }> };
}

export interface CareBoard {
  open: number;
  waitingOnUs: number;
  nearBreach: number;
  firstReplyMinutes: number;
  firstReplyTargetMinutes: number;
  drafts: { asIs: number; edited: number; discarded: number };
  csat: { percent: number; ratings: number };
  byPerson: Array<{ name: string; id: string; open: number }>;
}

const rep = { name: 'Aroha Ngata', id: 'CSR-1041' };

type Seed = Omit<CareTicket, 'stage' | 'timeline'> & { stage?: CareStage; clock?: string };

const SEEDS: Seed[] = [
  {
    id: 't4312', ref: '4312', subject: 'My vanity has not arrived', status: 'decide', channel: 'Contact form',
    message: 'I ordered a vanity on the 18th and it was meant to be here on Thursday. Nobody has called. Where is it?',
    customer: { name: 'Jess Carter', account: 'Retail customer', since: '2022', earlier: 'No open tickets' },
    assignee: rep, slaMinutes: 192, topic: { value: 'Delivery', confidence: 'High' }, mood: { value: 'Frustrated', confidence: 'Medium' },
    summary: 'Three days late. The carrier tried once. Rebook for Wednesday.',
    found: [
      { text: 'Order 7C41D9A2 shipped on 20 Oct. It was promised for 23 Oct.', source: { system: 'commercetools', label: 'Order 7C41D9A2' } },
      { text: 'The carrier tried on 24 Oct and nobody was home.', source: { system: 'commercetools', label: 'Shipment' } },
      { text: 'Four earlier orders and no open cases.', source: { system: 'Salesforce', label: 'Account' } },
    ],
    notChecked: ['Whether the carrier has a Wednesday slot. Their line was not checked.'],
    recommendation: 'Apologise, rebook delivery for Wednesday 28 Oct, and note it on the order.',
    otherOption: 'Offer pick-up from the Albany branch, where it is in stock.',
    order: {
      ref: '7C41D9A2', states: { order: 'Confirmed', shipment: 'Delayed', payment: 'Paid' }, promised: '23 Oct', actual: 'Not delivered',
      lines: [{ name: 'Wall hung vanity 900mm white gloss', quantity: 1 }], notes: ['24 Oct: carrier attempt failed'],
    },
    draft: { isReply: true, text: 'Kia ora Jess,\n\nI am sorry your vanity has not arrived. The carrier tried on 24 October and could not leave it. I have asked them to deliver on Wednesday 28 October and I will confirm as soon as they do. If that day does not suit, you can collect it from our Albany branch.\n\nNgā mihi,\nAroha' },
    replyChecks: [{ label: 'No refund, replacement or amount promised', ok: true }, { label: 'Dates come from the order', ok: true }],
    steps: [
      { id: 's1', system: 'Zendesk', kind: 'customer', what: 'Send the reply to Jess and set the ticket to', before: 'Open', after: 'Pending' },
      { id: 's2', system: 'commercetools', kind: 'internal', what: 'Add a note on order 7C41D9A2', after: 'Delivery rebooked for 28 Oct' },
      { id: 's3', system: 'Salesforce', kind: 'record', what: 'Create a case linked to Jess Carter', after: 'Late delivery' },
    ],
  },
  {
    id: 't4313', ref: '4313', subject: 'The basin mixer came cracked', status: 'decide', channel: 'Email',
    message: 'The mixer in my delivery has a crack in the spout. I am not happy.',
    customer: { name: 'Ben Ioane', account: 'Retail customer', since: '2024', earlier: 'No open tickets' },
    assignee: rep, slaMinutes: 480, topic: { value: 'Damaged item', confidence: 'High' }, mood: { value: 'Upset', confidence: 'Medium' },
    summary: 'No photo yet. Ask for one, then replace.',
    found: [
      { text: 'Order 9A6E10C4 had one Tube basin mixer, delivered on 22 Oct.', source: { system: 'commercetools', label: 'Order 9A6E10C4' } },
      { text: 'There is no photo with the email.', source: { system: 'Zendesk', label: 'Ticket 4313' } },
      { text: 'Six in stock at Albany.', source: { system: 'commercetools', label: 'Stock' } },
    ],
    notChecked: ['Whether it was damaged in transit or on site. The photo will show.'],
    recommendation: 'Ask for a photo of the damage and say a replacement follows once it arrives.',
    otherOption: 'Send the replacement now and ask for the photo afterwards.',
    order: {
      ref: '9A6E10C4', states: { order: 'Complete', shipment: 'Shipped', payment: 'Paid' }, promised: '22 Oct', actual: '22 Oct',
      lines: [{ name: 'Tube basin mixer', quantity: 1 }], notes: [],
    },
    draft: { isReply: true, text: 'Kia ora Ben,\n\nI am sorry the mixer arrived cracked. Could you reply with a photo of the damage? As soon as I have it, I will look at the next step with you.\n\nNgā mihi,\nAroha' },
    replyChecks: [{ label: 'No refund, replacement or amount promised', ok: true }, { label: 'Dates come from the order', ok: true }],
    steps: [
      { id: 's1', system: 'Zendesk', kind: 'customer', what: 'Send the reply and set the ticket to', before: 'Open', after: 'Pending' },
      { id: 's2', system: 'commercetools', kind: 'internal', what: 'Add a note on order 9A6E10C4', after: 'Damage reported, photo requested' },
      { id: 's3', system: 'Salesforce', kind: 'record', what: 'Create a case linked to Ben Ioane', after: 'Damaged item' },
    ],
  },
  {
    id: 't4315', ref: '4315', subject: 'Please cancel my order', status: 'decide', channel: 'Chat hand-over',
    message: 'I want to cancel order 5D09B7E1 please. I ordered the wrong size.',
    customer: { name: 'Lina Wu', account: 'Retail customer', since: '2023', earlier: 'No open tickets' },
    assignee: rep, slaMinutes: 11, topic: { value: 'Cancel order', confidence: 'High' }, mood: { value: 'Neutral', confidence: 'High' },
    summary: 'Not yet dispatched. Cancel and refund NZ$412.50.',
    found: [
      { text: 'Order 5D09B7E1 is not dispatched. Picking started at 9:10.', source: { system: 'commercetools', label: 'Order 5D09B7E1' } },
      { text: 'Paid by card, NZ$412.50.', source: { system: 'commercetools', label: 'Payment' } },
    ],
    notChecked: ['Whether the pick has been boxed. The branch can stop it.'],
    recommendation: 'Cancel the order and refund NZ$412.50 to the card.',
    otherOption: 'Offer to change the size on the order instead.',
    order: {
      ref: '5D09B7E1', states: { order: 'Confirmed', shipment: 'Pending', payment: 'Paid' }, promised: '28 Oct',
      lines: [{ name: 'Framing timber 90x45 4.8m', quantity: 40 }], notes: [],
    },
    draft: { isReply: true, text: 'Kia ora Lina,\n\nI have cancelled order 5D09B7E1. Your refund of NZ$412.50 goes back to your card and usually takes 3 to 5 working days.\n\nNgā mihi,\nAroha' },
    replyChecks: [{ label: 'Names a refund of NZ$412.50: it holds only if you approve the refund step', ok: false }, { label: 'Dates come from the order', ok: true }],
    steps: [
      { id: 's1', system: 'Zendesk', kind: 'customer', what: 'Send the reply and set the ticket to', before: 'Open', after: 'Solved' },
      { id: 's2', system: 'commercetools', kind: 'money', what: 'Cancel order 5D09B7E1 and record a refund of', before: 'Confirmed', after: 'Cancelled · NZ$412.50' },
      { id: 's3', system: 'Salesforce', kind: 'record', what: 'Log the case and close it', after: 'Closed' },
    ],
  },
  {
    id: 't4321', ref: '4321', subject: 'Third time. I want to close my account', status: 'lead', channel: 'Email',
    message: 'This is the third time I have written about late framing deliveries. I want to close my account.',
    customer: { name: 'Ana, Kauri Homes', account: 'Trade account', since: '2019', earlier: '#4290 and #4301, both solved' },
    assignee: rep, slaMinutes: -12, topic: { value: 'Complaint', confidence: 'High' }, mood: { value: 'Angry', confidence: 'High' },
    summary: 'High-value account, third contact. A person should call today.',
    found: [
      { text: 'Third contact in two weeks (#4290, #4301 and this one).', source: { system: 'Zendesk', label: 'Earlier tickets' } },
      { text: 'NZ$64k in the last 90 days, down 18%.', source: { system: 'Salesforce', label: 'Account' } },
      { text: 'Both earlier tickets were about late framing deliveries.', source: { system: 'Zendesk', label: 'Earlier tickets' } },
    ],
    notChecked: ['What was promised on the earlier calls. It was not written down.'],
    recommendation: 'Do not send an automatic apology. A person should call today.',
    otherOption: 'Offer a delivery review with the account manager.',
    draft: { isReply: false, text: 'Call notes for Hemi\n• Start with the two late framing deliveries.\n• Ask what would make the next three months work.\n• Sione Faleolo, the account manager, should join.' },
    replyChecks: [{ label: 'No refund, replacement or amount promised', ok: true }],
    steps: [
      { id: 's1', system: 'Zendesk', kind: 'internal', what: 'Reassign to Hemi Parata (TL-2001) with an internal note', before: 'Aroha Ngata', after: 'Hemi Parata' },
      { id: 's2', system: 'Salesforce', kind: 'record', what: 'Create a task for Sione Faleolo', after: 'Call Kauri Homes today' },
    ],
    needsLead: true,
  },
  {
    id: 't4308', ref: '4308', subject: 'Invoice copy', status: 'done', channel: 'Email',
    message: 'Could you send a copy of the April invoice?', customer: { name: 'Mei Tan, Tui Plumbing', account: 'Trade account', since: '2021', earlier: 'No open tickets' },
    assignee: rep, slaMinutes: 0, topic: { value: 'Invoice', confidence: 'High' }, mood: { value: 'Neutral', confidence: 'High' },
    summary: 'Invoice sent. Solved.', found: [], notChecked: [], recommendation: '', otherOption: '',
    draft: { isReply: true, text: '' }, replyChecks: [], steps: [],
  },
  {
    id: 't4305', ref: '4305', subject: 'Post size question', status: 'done', channel: 'Contact form',
    message: 'Which post size for a pergola corner?', customer: { name: 'Tom Reid', account: 'Retail customer', since: '2025', earlier: 'No open tickets' },
    assignee: rep, slaMinutes: 0, topic: { value: 'Product question', confidence: 'High' }, mood: { value: 'Neutral', confidence: 'High' },
    summary: 'Guide link sent. Solved.', found: [], notChecked: [], recommendation: '', otherOption: '',
    draft: { isReply: true, text: '' }, replyChecks: [], steps: [],
  },
];

const two = (n: number) => String(n).padStart(2, '0');
const OFFSET_SECONDS: Record<CareStage, number> = { arrived: 0, read: 2, researched: 7, drafted: 15, waiting: 15, running: 41, done: 49 };

/** What the AI and the person did at each stage up to `upTo`, with the time, for the "How I got here" list. */
export function timelineFor(t: Seed, upTo: CareStage, startMinute: number): CareTimelineEntry[] {
  const systems = [...new Set(t.found.map((f) => f.source.system))];
  const notes: Record<CareStage, string> = {
    arrived: `Ticket ${t.ref} reached Zendesk (${t.channel}).`,
    read: `Read it: topic ${t.topic.value.toLowerCase()}, mood ${t.mood.value.toLowerCase()}${t.order ? `, order ${t.order.ref} named` : ''}.`,
    researched: `Looked in ${systems.length ? systems.join(', ') : 'the sources'}${t.notChecked.length ? `; ${t.notChecked.length} thing could not be checked` : ''}.`,
    drafted: `Wrote a summary, ${t.draft.isReply ? 'a reply' : 'call notes'} and ${t.steps.length} change${t.steps.length === 1 ? '' : 's'}.`,
    waiting: t.needsLead ? 'Held for the team lead: a complaint, and the AI is not sure.' : `Assigned to ${t.assignee.name} (${t.assignee.id}) to decide.`,
    running: 'Approved. Making the changes.',
    done: `Approved by ${t.assignee.name}. All changes made.`,
  };
  return CARE_STAGES.filter((s) => stageIndex(s.id) <= stageIndex(upTo)).map((s) => {
    const sec = OFFSET_SECONDS[s.id];
    return { stage: s.id, at: `9:${two(startMinute + Math.floor(sec / 60))}:${two(sec % 60)}`, note: notes[s.id] };
  });
}

export const CARE_TICKETS: CareTicket[] = SEEDS.map((seed, i) => {
  const stage: CareStage = seed.stage ?? (seed.status === 'done' ? 'done' : 'waiting');
  return { ...seed, stage, timeline: timelineFor(seed, stage, 41 - i * 3) };
});

/** A ticket that reaches the ticket desk while the person is watching. The store reveals it stage by stage. */
const ARRIVAL: Seed = {
  id: 't4322', ref: '4322', subject: 'Where is my pergola order?', status: 'decide', channel: 'Contact form',
  message: 'I ordered the pergola posts last week. The page says processing. When will they be here?',
  customer: { name: 'Sam Shopper', account: 'Retail customer', since: '2025', earlier: 'No open tickets' },
  assignee: rep, slaMinutes: 240, topic: { value: 'Delivery', confidence: 'High' }, mood: { value: 'Neutral', confidence: 'High' },
  summary: 'Picked and ready. Give a firm date.',
  found: [
    { text: 'Order B13E7A55 is picked and waiting for the carrier. Promised for 29 Oct.', source: { system: 'commercetools', label: 'Order B13E7A55' } },
    { text: 'Paid in full. Delivery to Auckland 1010.', source: { system: 'commercetools', label: 'Payment' } },
    { text: 'One earlier order, no open cases.', source: { system: 'Salesforce', label: 'Account' } },
  ],
  notChecked: [],
  recommendation: 'Tell Sam the posts are picked and due on 29 Oct, and note it on the order.',
  otherOption: 'Offer pick-up from the Albany branch if the date does not suit.',
  order: { ref: 'B13E7A55', states: { order: 'Confirmed', shipment: 'Ready', payment: 'Paid' }, promised: '29 Oct', lines: [{ name: 'Glulam post 88 x 88 pre-primed 2.7m', quantity: 4 }], notes: [] },
  draft: { isReply: true, text: 'Kia ora Sam,\n\nYour posts are picked and ready for the carrier. They are due with you on 29 October. I will let you know if that changes.\n\nNgā mihi,\nAroha' },
  replyChecks: [{ label: 'No refund, replacement or amount promised', ok: true }, { label: 'Dates come from the order', ok: true }],
  steps: [
    { id: 's1', system: 'Zendesk', kind: 'customer', what: 'Send the reply and set the ticket to', before: 'Open', after: 'Pending' },
    { id: 's2', system: 'commercetools', kind: 'internal', what: 'Add a note on order B13E7A55', after: 'Customer told: due 29 Oct' },
  ],
};

/** The arriving ticket as it looks once it has reached `stage`. */
export function arrivalTicket(stage: CareStage): CareTicket {
  return { ...ARRIVAL, status: stage === 'waiting' ? 'decide' : stage === 'done' ? 'done' : stage === 'running' ? 'waiting' : 'ai', stage, timeline: timelineFor(ARRIVAL, stage, 44) };
}

export const CARE_BOARD: CareBoard = {
  open: 7, waitingOnUs: 3, nearBreach: 2, firstReplyMinutes: 14, firstReplyTargetMinutes: 30,
  drafts: { asIs: 61, edited: 31, discarded: 8 }, csat: { percent: 88, ratings: 24 },
  byPerson: [
    { name: 'Aroha Ngata', id: 'CSR-1041', open: 4 }, { name: 'Tane Walker', id: 'CSR-1042', open: 3 },
    { name: 'Mei Lin Tan', id: 'CSR-1043', open: 2 }, { name: 'Hemi Parata', id: 'TL-2001', open: 1 },
  ],
};

export const careTicket = (id: string | undefined): CareTicket | undefined => CARE_TICKETS.find((t) => t.id === id || t.ref === id);

/** The ticket to take next: the soonest promised time among those this person can decide (a team-lead ticket is not theirs to approve). */
export function nextCareTicket(tickets: readonly CareTicket[] = CARE_TICKETS): CareTicket | undefined {
  return tickets.filter((t) => t.status === 'decide').sort((a, b) => a.slaMinutes - b.slaMinutes)[0];
}

/** What a person may correct the AI's labels to. Corrections are kept on the ticket with who made them; they do not retrain the model. */
export const CARE_TOPICS = ['Delivery', 'Damaged item', 'Wrong or missing item', 'Cancel order', 'Change of address', 'Return or refund', 'Invoice', 'Warranty', 'Product question', 'Complaint'];
export const CARE_MOODS = ['Very positive', 'Positive', 'Neutral', 'Frustrated', 'Upset', 'Angry'];

/** The promised-time clock the way the ticket desk draws it: over 15 minutes is fine, under is close, negative is late. */
export function slaClock(minutes: number): { text: string; tone: 'ok' | 'warn' | 'bad'; icon: string } {
  const abs = Math.abs(minutes);
  const span = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs}m`;
  if (minutes < 0) return { text: `Late ${span}`, tone: 'bad', icon: '▲' };
  if (minutes <= 15) return { text: `${span} left`, tone: 'warn', icon: '!' };
  return { text: `${span} left`, tone: 'ok', icon: '✓' };
}

export const STATUS_WORD: Record<CareStatus, { word: string; icon: string; tone: 'wait' | 'info' | 'ok' | 'bad' }> = {
  ai: { word: 'AI working', icon: '◐', tone: 'info' },
  decide: { word: 'Decide', icon: '●', tone: 'wait' },
  waiting: { word: 'Waiting', icon: '◐', tone: 'info' },
  done: { word: 'Done', icon: '✓', tone: 'ok' },
  lead: { word: 'Team lead', icon: '▲', tone: 'bad' },
};
