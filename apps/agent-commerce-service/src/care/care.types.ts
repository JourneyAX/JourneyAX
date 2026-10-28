/**
 * Customer care: a ticket that has reached the ticket desk, the AI's work on it, and what a named person decided.
 *
 * The shapes the portal draws (`CareTicketView`) use the same names as the care canvases in the web app, so what the server sends is what the
 * canvases show. The case file (`CareCase`) holds more: which tenant, the ticket desk's own id and last-changed time (so a change is noticed once),
 * and the approval record.
 */
export type CareStage = 'arrived' | 'read' | 'researched' | 'drafted' | 'waiting' | 'running' | 'done';
export type CareStatus = 'ai' | 'decide' | 'waiting' | 'done' | 'lead';
export type CareSystem = 'Zendesk' | 'commercetools' | 'Salesforce' | 'SAP ERP';
/** Which desk a case belongs to. A case with no desk is a customer-care ticket. */
export type DeskKind = 'care' | 'stock';
export type CareStepKind = 'customer' | 'internal' | 'record' | 'money';
export type CareConfidence = 'High' | 'Medium' | 'Low';

export const STAGE_ORDER: CareStage[] = ['arrived', 'read', 'researched', 'drafted', 'waiting', 'running', 'done'];
export const stageRank = (stage: CareStage): number => STAGE_ORDER.indexOf(stage);

export interface CareStep {
  id: string;
  system: CareSystem;
  kind: CareStepKind;
  /** What will happen, in plain words. */
  what: string;
  before?: string;
  after?: string;
  /** The action the write-back runs for this step: a tool name and its arguments, fixed by the server and never by the model. */
  action?: { tool: string; args: Record<string, unknown> };
}

export interface CareFact { text: string; source: { system: CareSystem; label: string } }
export interface CareTimelineEntry { stage: CareStage; at: string; note: string }
export interface CareOrder {
  ref: string;
  states: { order: string; shipment: string; payment: string };
  promised?: string;
  actual?: string;
  lines: Array<{ name: string; quantity: number }>;
  notes: string[];
}

export interface CareCorrection { from: string; to: string }

/** A stock exception's own facts, drawn as a table of branches: the product, what is short where, and what every branch holds. */
export interface StockExceptionDetail {
  product: { sku: string; name: string };
  short: { branch: string; needed: number; onHand: number };
  /** Every branch's stock, the short one first, then the best source, then the rest. */
  branches: Array<{ name: string; onHand: number; spare: number; role: 'short' | 'source' | 'other'; note?: string }>;
}

/** What the care desk did at one stage, for finding out afterwards what went wrong: how long, which tools, whether the model was used, any fallback. */
export interface CareTrace {
  stage: CareStage;
  ms: number;
  tools: Array<{ system: string; tool: string; ok: boolean; ms: number }>;
  modelCalls: number;
  tokens: number;
  fallback?: string;
}

export interface CareApproval {
  by: { name: string; id: string };
  at: string;
  /** A fingerprint of the draft and the steps as the person saw them; an approval holds only for exactly that. */
  contentHash: string;
  edited: boolean;
  removedSteps: string[];
  /** Where the person disagreed with the AI's reading: the labels they changed. */
  corrections?: { topic?: CareCorrection; mood?: CareCorrection };
  results: Array<{ stepId: string; ok: boolean; message?: string }>;
}

export interface CareCase {
  tenantId: string;
  id: string;
  /** Absent means a customer-care ticket. */
  desk?: DeskKind;
  ref: string;
  /** The ticket desk's own number; for a stock exception, the number the ERP gave it. */
  zendeskId: number;
  zendeskUpdatedAt: string;
  subject: string;
  channel: string;
  message: string;
  requester: { name?: string; email?: string };
  createdAt: string;
  updatedAt: string;
  stage: CareStage;
  status: CareStatus;
  /** When the ticket's first reply is promised, as a time. */
  dueAt: string;
  assignee: { name: string; id: string };
  customer: { name: string; account: string; since: string; earlier: string };
  topic: { value: string; confidence: CareConfidence };
  mood: { value: string; confidence: CareConfidence };
  found: CareFact[];
  notChecked: string[];
  summary: string;
  recommendation: string;
  otherOption: string;
  order?: CareOrder;
  /** Set on a stock exception: what is short, where, and what every branch holds. */
  stock?: StockExceptionDetail;
  draft: { isReply: boolean; text: string; original: string };
  replyChecks: Array<{ label: string; ok: boolean }>;
  steps: CareStep[];
  needsLead: boolean;
  timeline: CareTimelineEntry[];
  approval?: CareApproval;
  /** Set when a worker takes the ticket, so two copies of the service never both work it. */
  claimedAt?: string;
  /** The record of how the AI got here, for the team and not for the customer. */
  trace?: CareTrace[];
  /** What the source system raised, as it gave it (a stock exception). Server only. */
  raw?: Record<string, unknown>;
}

/** What the portal's canvases draw. The server-only parts (the actions behind the steps, the approval's fingerprint) are left out. */
export interface CareTicketView extends Omit<CareCase, 'tenantId' | 'requester' | 'zendeskId' | 'zendeskUpdatedAt' | 'createdAt' | 'updatedAt' | 'dueAt' | 'steps' | 'draft' | 'approval' | 'claimedAt' | 'trace' | 'raw'> {
  slaMinutes: number;
  /** Who approved, when, and how each change went. The fingerprint stays on the server. */
  approval?: Omit<CareApproval, 'contentHash'>;
  steps: Array<Omit<CareStep, 'action'>>;
  draft: { isReply: boolean; text: string };
}

export type CareEvent = { type: 'ticket'; ticket: CareTicketView };
