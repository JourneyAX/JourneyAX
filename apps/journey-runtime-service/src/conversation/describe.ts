import type { CatalogOutcome } from './search';
import type { ConversationPlan } from './types';

/**
 * One plain line per turn for the service log: which pack and knowledge release answered, how the customer's words were matched,
 * what the conversation decided and why, what was put on screen, and whether the slow model read was needed. Everything a person
 * reading the log needs to follow a conversation without opening the trace.
 */
export function describeTurn(input: {
  packVersion?: string;
  okfRelease: string;
  knowledgeMode?: string;
  conceptId?: string;
  matchedBy?: string;
  plan?: ConversationPlan | null;
  /** Set when the turn ended before a conversation decision was possible (a safety outcome, no matching journey…). */
  endedBecause?: string;
  cards: string[];
  /** What the live catalogue search did, so an empty answer can be told apart from a search that never ran or failed. */
  search?: CatalogOutcome;
  modelRead: string;
}): string {
  const concept = input.conceptId ? input.conceptId.replace(/^concept:\/\//, '').split('/').slice(-2).join('/') : 'no concept';
  const parts = [
    `pack ${input.packVersion ?? 'none'}`,
    `knowledge ${input.okfRelease}`,
    `${input.knowledgeMode ?? 'no knowledge decision'} · ${concept}${input.matchedBy ? ` (${input.matchedBy})` : ''}`,
  ];
  const plan = input.plan;
  if (plan && plan.action !== 'defer') {
    const question = plan.question ? ` [${plan.question.source === 'okf' ? 'release question' : 'built from products'}: ${plan.question.factKey}]` : '';
    const shown = plan.products.length ? ` [${plan.products.length} product${plan.products.length === 1 ? '' : 's'}${plan.products.some((entry) => entry.why?.excerpt) ? ', reason quoted' : ''}]` : '';
    parts.push(`decided ${plan.action}${question}${shown}: ${plan.because.join(' → ')}`);
  } else {
    parts.push(plan ? `decision left to the existing flow: ${plan.because.join(' → ')}` : input.endedBecause ? `ended early: ${input.endedBecause}` : 'no conversation decision');
  }
  if (input.search) {
    parts.push(!input.search.ran ? 'catalogue search: not run' : input.search.failed ? `catalogue search: failed${input.search.error ? ` (${input.search.error})` : ''}` : `catalogue search: ${input.search.items.length} product${input.search.items.length === 1 ? '' : 's'}`);
  }
  parts.push(`cards: ${input.cards.length ? input.cards.join(', ') : 'none'}`);
  parts.push(`model read: ${input.modelRead}`);
  return `[Turn] ${parts.join(' | ')}`;
}
