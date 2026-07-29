/**
 * Pipeline types — the controlled conversation flow (§5 of docs/ARCHITECTURE.md).
 *
 * The agent is one visible assistant, but internally each message runs through
 * explicit, observable steps: intent → retrieval policy → generate → validate.
 * These types are the contract passed between those steps.
 */

export type ConversationMode = 'business' | 'technical';

/** Output of the intent-resolver step. */
export interface IntentResult {
  /** e.g. bathroom_remodel | leak_repair | product_recommendation | installation_help | quote_order | design_inspiration | unknown */
  intent: string;
  /** Journey stage the customer is in: intro | clarify | products | quote | ordered | installation */
  stage: string;
  /** business = consultative selling; technical = grounded install/repair/specs. */
  mode: ConversationMode;
  /**
   * Values extracted for the project's configured CONTEXT DIMENSIONS this turn, e.g.
   * Caroma { space:"Kitchen", projectType:"renovation" } · Fashion { occasion:"party" }.
   * Keys are whatever the project configured (contextDimensions). Only confidently
   * extracted values appear. Retrieval scopes by the ones marked filtersRetrieval.
   */
  dimensions?: Record<string, string>;
  /** False when the request falls outside every scoping dimension the business serves. */
  inScope?: boolean;
  /**
   * Back-compat convenience = dimensions.space (or "general"/"out_of_scope"). Retained
   * so existing room-based scoping keeps working; new verticals use `dimensions`.
   */
  space?: string;
  /** Whether this turn needs knowledge retrieval at all (discovery usually does NOT). */
  needsRetrieval: boolean;
  /** Which knowledge type(s) are appropriate to retrieve for this intent. */
  retrievalType?: string;
  confidence: number;
  /** Context slots still missing (drives clarifying questions). */
  missingInfo: string[];
  /** Free-text org the customer is buying for — school/college/club/team/company (AUG-48). */
  organization?: { name: string; location?: string };
}

/** One observable step in the reasoning trace (surfaced to the right-hand panel). */
export interface TraceEntry {
  step: string;
  detail: string;
  data?: unknown;
}
