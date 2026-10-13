import type { ConversationPolicy } from './policy';
import type { ConversationState, QuestionOption } from './types';
import { isCardAnswerLine } from './needs';
import { tokens } from './text';

export const STATE_KEY = 'conversation_state';

export const emptyState = (conceptId?: string): ConversationState => ({ conceptId, terms: [], surfaces: {}, constraints: { brands: [] }, asked: [] });

export function readState(facts: Record<string, { value?: unknown }> | undefined): ConversationState | undefined {
  const value = facts?.[STATE_KEY]?.value as ConversationState | undefined;
  return value && typeof value === 'object' && Array.isArray(value.terms) ? structuredClone(value) : undefined;
}

export function writeState(workspace: { facts: Record<string, any> }, state: ConversationState): void {
  workspace.facts[STATE_KEY] = { value: state, source: 'system', confidence: 1, extractedAt: new Date().toISOString() };
}

const same = (a: string, b: string) => tokens(a).join(' ') === tokens(b).join(' ');

/**
 * A tapped answer to a question the platform built from the products (not from the release) arrives as text, like every card answer.
 * It is read against the question that was on screen, so it never depends on a model and a plain word like "wipes" is an answer
 * here, not a new request. Typing an option's own words counts too.
 */
export function readDynamicAnswer(message: string, state: ConversationState | undefined): QuestionOption | undefined {
  const pending = state?.pending;
  if (!pending) return undefined;
  const match = (text: string) => pending.options.find((option) => same(option.value, text) || same(option.label, text));
  for (const line of message.split(/\n+/)) {
    if (!isCardAnswerLine(line)) continue;
    const [left, ...right] = line.split(/→|->/);
    if (same(left, pending.question)) { const option = match(right.join('→').trim()); if (option) return option; }
  }
  return match(message.trim());
}

export function applyAnswer(state: ConversationState, option: QuestionOption, policy: ConversationPolicy): void {
  const constraint = option.constraint ?? {};
  for (const term of constraint.terms ?? []) if (!state.terms.includes(term)) { state.terms.push(term); state.surfaces[term] = option.label.toLowerCase(); }
  if (constraint.brand && !state.constraints.brands.includes(constraint.brand)) state.constraints.brands.push(constraint.brand);
  if (constraint.priceMin !== undefined) state.constraints.priceMin = constraint.priceMin;
  if (constraint.priceMax !== undefined) state.constraints.priceMax = constraint.priceMax;
  state.pending = undefined;
  void policy;
}
