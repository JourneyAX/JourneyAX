/**
 * The words the care screens use for each desk. The customer-care desk and the stock exceptions desk are drawn by the same three canvases (the
 * list, the board, the one-case page); everything that differs between them is here, so the canvases hold no desk's wording of their own.
 */
import { CARE_MOODS, CARE_STAGES, CARE_TOPICS, type CareStageInfo, type DeskKind } from './careData';

export interface DeskWords {
  /** Small heading above the list and the board. */
  eyebrow: string;
  queueTitle: string;
  boardTitle: string;
  /** One case, and several: "ticket", "tickets". */
  one: string;
  many: string;
  /** What goes before a case's reference on screen ("#4322", "EX-7301"). */
  refPrefix: string;
  /** The canvas kinds this desk opens. */
  kinds: { queue: 'care-queue' | 'stock-queue' | 'quotes-queue' | 'invoices-queue'; board: 'care-board' | 'stock-board' | 'quotes-board' | 'invoices-board'; ticket: 'care-ticket' | 'stock-ticket' | 'quotes-ticket' | 'invoices-ticket' };
  stages: CareStageInfo[];
  topicLabel: string;
  moodLabel: string;
  topics: string[];
  moods: string[];
  /** The heading over the case's own words, and the line shown while the AI has not started reading. */
  wrote: string;
  waitingToRead: string;
  researching: string;
  drafting: string;
  noneYet: string;
  sortedBy: string;
  /** Over the draft, and whether the draft is something that goes to the customer. */
  noteHeading: (customerFirstName: string, isReply: boolean) => string;
  noteIsInternal: string;
  checksLabel: string;
  /** The line in the done notice: "The reply was sent as written." */
  doneNote: string;
  asWritten: string;
  leadReason: string;
  /** The name of the team lead, when the screen can say it. */
  sendToLead: (leadName: string) => string;
  sentToLead: (leadName: string) => string;
  /** Shown for a case whose changes include nothing a person can approve. */
  showChecksAlways: boolean;
  /** What the desk says to someone who may not use it, and when it cannot be reached. */
  staffOnly: string;
  unreachable: string;
}

const STOCK_STAGES: CareStageInfo[] = [
  { id: 'arrived', word: 'Raised', doing: 'Raised by SAP ERP. Waiting for the AI.' },
  { id: 'read', word: 'AI read it', doing: 'Reading what was flagged: the kind of exception and how urgent it is.' },
  { id: 'researched', word: 'AI researched', doing: 'Checking stock in every branch, the order and a similar product.' },
  { id: 'drafted', word: 'Plan ready', doing: 'Writing the summary, the plan and the list of changes.' },
  { id: 'waiting', word: 'Waiting for approval', doing: 'With a named branch person to approve, edit or reject.' },
  { id: 'running', word: 'Changes running', doing: 'Making the approved changes in each system.' },
  { id: 'done', word: 'Done', doing: 'Sorted. Recorded with who approved it.' },
];

export const STOCK_TOPICS = ['Short at branch', 'Damaged in store', 'Late from supplier', 'Count mismatch'];
export const STOCK_URGENCY = ['Routine', 'Soon', 'Urgent'];
export const QUOTE_TOPICS = ['New quote', 'Repeat order', 'Large job', 'Price check'];
export const INVOICE_TOPICS = ['Price mismatch', 'Quantity mismatch', 'Duplicate invoice', 'Missing credit note'];

const INVOICE_STAGES: CareStageInfo[] = [
  { id: 'arrived', word: 'Flagged', doing: 'Flagged by SAP ERP. Waiting for the AI.' },
  { id: 'read', word: 'AI read it', doing: 'Reading what the customer says is wrong and how urgent it is.' },
  { id: 'researched', word: 'AI matched it', doing: 'Comparing the invoice with the order, the delivery and the agreed prices.' },
  { id: 'drafted', word: 'Credit ready', doing: 'Writing the summary, the email and the list of changes.' },
  { id: 'waiting', word: 'Waiting for approval', doing: 'With a named credit controller to approve, edit or reject.' },
  { id: 'running', word: 'Changes running', doing: 'Making the approved changes in each system.' },
  { id: 'done', word: 'Done', doing: 'Corrected. Recorded with who approved it.' },
];

const QUOTE_STAGES: CareStageInfo[] = [
  { id: 'arrived', word: 'Requested', doing: 'Raised by Salesforce. Waiting for the AI.' },
  { id: 'read', word: 'AI read it', doing: 'Reading what the customer asked for: the kind of request and how urgent it is.' },
  { id: 'researched', word: 'AI priced it', doing: 'Checking the account, the trade prices, stock at the branch and earlier quotes.' },
  { id: 'drafted', word: 'Quote ready', doing: 'Writing the summary, the email and the list of changes.' },
  { id: 'waiting', word: 'Waiting for approval', doing: 'With a named sales rep to approve, edit or reject.' },
  { id: 'running', word: 'Changes running', doing: 'Making the approved changes in each system.' },
  { id: 'done', word: 'Done', doing: 'Sent. Recorded with who approved it.' },
];

const CARE: DeskWords = {
  eyebrow: 'Customer care', queueTitle: 'My tickets', boardTitle: 'Care board', one: 'ticket', many: 'tickets', refPrefix: '#',
  kinds: { queue: 'care-queue', board: 'care-board', ticket: 'care-ticket' },
  stages: CARE_STAGES, topicLabel: 'Topic', moodLabel: 'Mood', topics: CARE_TOPICS, moods: CARE_MOODS,
  wrote: 'What the customer wrote', waitingToRead: 'Waiting for the AI to start reading this ticket.',
  researching: 'Looking up the order, the account and earlier tickets.', drafting: 'Working out what to do, and writing the reply and the list of changes.',
  noneYet: 'No tickets yet. A new one appears here as soon as it reaches Zendesk, and you can watch the AI work on it.',
  sortedBy: 'Sorted by the promised time, soonest first. Nothing is sent or changed until you approve.',
  noteHeading: (first, isReply) => (isReply ? `Reply to ${first}` : 'Call notes'),
  noteIsInternal: 'Internal only. Nothing here goes to the customer.', checksLabel: 'Checks on this reply', doneNote: 'The reply was', asWritten: 'sent as written',
  leadReason: 'it is a complaint, and the AI is not sure.',
  sendToLead: (lead) => `Send to ${lead || 'Hemi Parata (TL-2001)'}`, sentToLead: (lead) => `Sent to ${lead || 'Hemi Parata (TL-2001)'}. It shows in the team lead's list as Decide. Nothing has gone to the customer.`,
  showChecksAlways: false,
  staffOnly: 'Customer care only.', unreachable: 'Could not reach the care desk.',
};

const STOCK: DeskWords = {
  eyebrow: 'Stock', queueTitle: 'Stock exceptions', boardTitle: 'Stock board', one: 'exception', many: 'exceptions', refPrefix: '',
  kinds: { queue: 'stock-queue', board: 'stock-board', ticket: 'stock-ticket' },
  stages: STOCK_STAGES, topicLabel: 'Kind', moodLabel: 'Urgency', topics: STOCK_TOPICS, moods: STOCK_URGENCY,
  wrote: 'What was flagged', waitingToRead: 'Waiting for the AI to start reading this exception.',
  researching: 'Checking stock in every branch, the order and a similar product.', drafting: 'Working out what to move, and writing the plan and the list of changes.',
  noneYet: 'No exceptions yet. A new one appears here as soon as SAP ERP raises it, and you can watch the AI work on it.',
  sortedBy: 'Sorted by the time the truck must leave, soonest first. Nothing is changed until you approve.',
  noteHeading: () => 'Note for the counter',
  noteIsInternal: 'Internal only. Nothing here goes to the customer. A task reminds a person to ring them.', checksLabel: 'Checks on this plan', doneNote: 'The note was', asWritten: 'kept as written',
  leadReason: 'no branch can cover it on its own, or the AI is not sure.',
  sendToLead: (lead) => (lead ? `Send to ${lead}` : 'Send to the team lead'), sentToLead: (lead) => `Sent to ${lead || 'the team lead'}. It shows in the team lead's list as Decide. Nothing has been changed.`,
  showChecksAlways: true,
  staffOnly: 'Branch staff only.', unreachable: 'Could not reach the stock desk.',
};

const QUOTES: DeskWords = {
  eyebrow: 'Quotes', queueTitle: 'Quote requests', boardTitle: 'Quotes board', one: 'quote request', many: 'quote requests', refPrefix: '',
  kinds: { queue: 'quotes-queue', board: 'quotes-board', ticket: 'quotes-ticket' },
  stages: QUOTE_STAGES, topicLabel: 'Kind', moodLabel: 'Urgency', topics: QUOTE_TOPICS, moods: STOCK_URGENCY,
  wrote: 'What the customer asked', waitingToRead: 'Waiting for the AI to start reading this request.',
  researching: 'Checking the account, the trade prices, stock at the branch and earlier quotes.', drafting: 'Pricing the quote, and writing the email and the list of changes.',
  noneYet: 'No quote requests yet. A new one appears here as soon as Salesforce raises it, and you can watch the AI price it.',
  sortedBy: 'Sorted by the time the quote is due, soonest first. Nothing is sent or changed until you approve.',
  noteHeading: (first, isReply) => (isReply ? `Email to ${first}` : 'Notes for the rep'),
  noteIsInternal: 'Internal only. Nothing here goes to the customer.', checksLabel: 'Checks on this quote', doneNote: 'The email was', asWritten: 'sent as written',
  leadReason: 'the account, the size of the quote or a missing price needs the sales manager, or the AI is not sure.',
  sendToLead: (lead) => (lead ? `Send to ${lead}` : 'Send to the sales manager'), sentToLead: (lead) => `Sent to ${lead || 'the sales manager'}. It shows in their list as Decide. Nothing has been sent to the customer.`,
  showChecksAlways: true,
  staffOnly: 'Sales staff only.', unreachable: 'Could not reach the quotes desk.',
};

const INVOICES: DeskWords = {
  eyebrow: 'Finance', queueTitle: 'Invoice exceptions', boardTitle: 'Invoice board', one: 'invoice exception', many: 'invoice exceptions', refPrefix: '',
  kinds: { queue: 'invoices-queue', board: 'invoices-board', ticket: 'invoices-ticket' },
  stages: INVOICE_STAGES, topicLabel: 'Kind', moodLabel: 'Urgency', topics: INVOICE_TOPICS, moods: STOCK_URGENCY,
  wrote: 'What the customer said', waitingToRead: 'Waiting for the AI to start reading this exception.',
  researching: 'Comparing the invoice with the order, the delivery and the agreed prices.', drafting: 'Working out the credit, and writing the email and the list of changes.',
  noneYet: 'No invoice exceptions yet. A new one appears here as soon as SAP ERP flags an invoice, and you can watch the AI match it.',
  sortedBy: 'Sorted by the time an answer is due, soonest first. Nothing is sent or changed until you approve.',
  noteHeading: (first, isReply) => (isReply ? `Email to ${first}` : 'Notes for the controller'),
  noteIsInternal: 'Internal only. Nothing here goes to the customer.', checksLabel: 'Checks on this correction', doneNote: 'The email was', asWritten: 'sent as written',
  leadReason: 'the credit is over what a controller may decide, or the AI found no difference or is not sure.',
  sendToLead: (lead) => (lead ? `Send to ${lead}` : 'Send to the finance manager'), sentToLead: (lead) => `Sent to ${lead || 'the finance manager'}. It shows in their list as Decide. Nothing has been sent to the customer.`,
  showChecksAlways: true,
  staffOnly: 'Finance staff only.', unreachable: 'Could not reach the invoices desk.',
};

export const deskWords = (desk: DeskKind | undefined): DeskWords => (desk === 'stock' ? STOCK : desk === 'quotes' ? QUOTES : desk === 'invoices' ? INVOICES : CARE);
export const deskOf = (t: { desk?: DeskKind } | undefined): DeskKind => (t?.desk === 'stock' || t?.desk === 'quotes' || t?.desk === 'invoices' ? t.desk : 'care');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Wednesday 11 November" for a day written YYYY-MM-DD, or '' when it is not one. A day has no time zone here: it is the date the system wrote. */
export function dayLabel(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
/** Money in the currency the system declared ("NZD" reads "$4,250.12" in New Zealand); with no declared currency, a plain number and no symbol. */
export const formatMoney = (n: number, currency?: string): string => (currency
  ? new Intl.NumberFormat('en-NZ', { style: 'currency', currency }).format(n)
  : n.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
