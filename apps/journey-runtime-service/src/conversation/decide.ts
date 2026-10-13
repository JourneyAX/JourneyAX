import { renderOkfMessage, type ClaimClass } from '@journeyax/knowledge';
import type { CatalogOutcome } from './search';
import { facetQuestion, satisfies } from './facets';
import { conceptWordsOf, extractNeeds, isCardAnswerLine } from './needs';
import type { ConversationPolicy } from './policy';
import { brandOf, rankProducts, reasonFor } from './relevance';
import { stem } from './text';
import { howToAnswer } from './howto';
import { applyAnswer, emptyState, readDynamicAnswer } from './state';
import { fill, listWords, pick, tokens } from './text';
import type { ConversationPlan, ConversationState, PlannedProduct, Product, QuestionPlan } from './types';

/** The part of the knowledge decision this step reads. */
export interface GateView {
  mode: string;
  conceptId?: string;
  retrieval: { permission?: string; groups?: Array<{ label: string }>; categoryPaths?: string[][] };
  clarification?: { factKey: string; question: string; uiInputType: string; options: Array<{ value: string; label: string }> };
  claims: { allowedClasses: ClaimClass[] };
  trace: { reasonCodes: string[] };
  messages?: Record<string, string>;
}

export interface DecideInput {
  message: string;
  gate: GateView | null | undefined;
  /** What the catalogue search returned this turn. */
  items: Product[];
  /** Whether the search ran at all, and whether it failed; an empty list from a search that ran is an answer, not a reason to ask a model. */
  search?: Pick<CatalogOutcome, 'ran' | 'failed' | 'error'>;
  /** The tenant's wording, already layered (knowledge policy over pack messages over platform defaults). */
  messages?: Record<string, string>;
  state?: ConversationState;
  policy: ConversationPolicy;
  /** Makes the choice among equal wordings stable for one conversation and turn. */
  seed: string;
}

/** Modes where another part of the platform owns the reply (safety, evidence, orders, projects, nothing matched). */
const OWNED_ELSEWHERE = new Set(['safety_then_diagnose', 'evidence_answer', 'operational_journey', 'service_intake', 'project_journey', 'no_match', 'knowledge_unavailable', 'legacy_search']);

/**
 * The one decision each turn: what a good salesperson would do next, as rules.
 *
 *   ask        not enough to choose well, and a question would help: the question, and no products yet
 *   recommend  the customer has said enough: the best fit, with the reason for each, taken from the product's own text
 *   show       the customer wants to browse (or there is nothing to narrow by): a short list, no pretended reasons
 *   answer     a how-to or comparison question: words only, no cards
 *   empty      the shop looked and has nothing to show: said plainly in the tenant's words, never improvised by a model
 *   defer      another part of the platform owns this reply
 *
 * Every threshold and every sentence comes from the policy. Nothing here knows what a department or a product is.
 */
export function decideConversation(input: DecideInput): ConversationPlan {
  const { gate, policy, message } = input;
  const because: string[] = [];
  const concept = gate?.conceptId;
  const state: ConversationState = input.state && input.state.conceptId === concept ? structuredClone(input.state) : emptyState(concept);
  const plan = (action: ConversationPlan['action'], over: Partial<ConversationPlan> = {}): ConversationPlan => ({
    action, because, needs: state.terms.map((term) => state.surfaces[term] ?? term), products: [],
    showCards: { question: false, products: false, suggestions: false }, nextState: state, ...over,
  });

  if (!gate) { because.push('no knowledge decision: the existing flow runs'); return plan('defer'); }
  if (OWNED_ELSEWHERE.has(gate.mode)) { because.push(`mode '${gate.mode}' is owned by another part of the platform`); return plan('defer'); }

  const codes = gate.trace.reasonCodes;
  let forceShow = codes.includes('customer_declined_questions') || codes.includes('exact_sku') || codes.some((code) => code.startsWith('uncovered_shopping_catalogue_only'));
  const answered = readDynamicAnswer(message, input.state && input.state.conceptId === concept ? state : undefined);
  if (answered) {
    applyAnswer(state, answered, policy);
    because.push(`the customer answered "${answered.label}"`);
    if (answered.constraint?.any) forceShow = true;
  }

  const lines = message.split(/\n+/);
  const cardAnswer = lines.some(isCardAnswerLine);
  const words = ` ${tokens(message).join(' ')} `;
  const said = (list: string[]) => !cardAnswer && !answered && list.some((phrase) => words.includes(` ${tokens(phrase).join(' ')} `));
  const howTo = said(policy.howToPhrases);
  if (howTo || said(policy.answerPhrases)) {
    because.push('a how-to or comparison question: answered in words, with no cards');
    if (howTo) {
      // Steps come from the product's own details or not at all; a model asked for steps makes them up.
      const own = howToAnswer(input.items, extractNeeds(message, conceptWordsOf(gate), policy).terms, gate.claims.allowedClasses, policy);
      if (own) { because.push(own.quoted ? 'the usage steps are quoted from the product' : 'the product has no usage steps on file: said plainly'); return plan('answer', { message: own.message }); }
    }
    return plan('answer');
  }

  const browse = !cardAnswer && !answered && policy.browsePhrases.some((phrase) => words.includes(` ${tokens(phrase).join(' ')} `));

  const conceptWords = conceptWordsOf(gate);
  const fresh = extractNeeds(message, conceptWords, policy);
  // A brand the customer names ("hammers by Estwing") is an answer about brand, not a product word to match.
  const spoken = new Set(tokens(lines.filter((line) => !isCardAnswerLine(line)).join(' ')));
  const brands = new Map<string, string>();
  for (const item of input.items) { const brand = brandOf(item); if (brand) brands.set(brand.toLowerCase(), brand); }
  for (const [key, label] of brands) {
    const parts = tokens(label);
    if (!parts.length || !parts.every((part) => spoken.has(part)) || state.constraints.brands.includes(key)) continue;
    state.constraints.brands.push(key);
    if (!state.asked.includes('brand')) state.asked.push('brand');
    for (const part of parts) { const at = fresh.terms.indexOf(stem(part, policy)); if (at >= 0) fresh.terms.splice(at, 1); }
    because.push(`the customer asked for ${label}`);
  }
  for (const term of fresh.terms) if (!state.terms.includes(term)) { state.terms.push(term); state.surfaces[term] = fresh.surfaces[term]; }
  const okf = gate.clarification
    ? ({ source: 'okf', factKey: gate.clarification.factKey, question: gate.clarification.question, uiInputType: gate.clarification.uiInputType, options: gate.clarification.options.map((option) => ({ value: option.value, label: option.label })) } satisfies QuestionPlan)
    : undefined;

  const askedKind = (question: QuestionPlan) => (question.source === 'okf' ? `okf:${question.factKey}` : question.factKey.replace(/^facet_/, ''));
  const ask = (question: QuestionPlan, many: boolean): ConversationPlan => {
    state.pending = question;
    if (!state.asked.includes(askedKind(question))) state.asked.push(askedKind(question));
    return plan('ask', {
      question, showCards: { question: true, products: false, suggestions: false },
      message: pick(many ? policy.templates.askMany : policy.templates.ask, input.seed),
    });
  };

  if (gate.mode === 'clarify_then_search' && okf) { because.push('the release needs this answer before any product is chosen'); return ask(okf, false); }

  let candidates = input.items.filter((item) => satisfies(item, state.constraints));
  if (candidates.length === 0 && input.items.length > 0) {
    // The answers so far leave nothing (the range changed since they were given): start again rather than leave a dead end.
    state.constraints = { brands: [] };
    candidates = input.items;
    because.push('the answers so far leave no product: starting again from the whole range');
  }
  if (candidates.length === 0) {
    if (!input.search?.ran) { because.push('no catalogue search ran: the existing flow runs'); return plan('defer'); }
    because.push(input.search.failed ? `the catalogue search failed${input.search.error ? ` (${input.search.error})` : ''}` : 'the catalogue search found no product');
    // A question needs no products, so the release's own question is still asked; otherwise the shop says plainly it has nothing to show.
    if (okf && !forceShow && !state.asked.includes(askedKind(okf))) { because.push('the release has a question that does not need products'); return ask(okf, false); }
    return plan('empty', { message: renderOkfMessage(input.messages ?? gate.messages ?? {}, 'nothing_to_show') });
  }

  const { ranked, informative } = rankProducts(candidates, state.terms, policy);
  const top = ranked[0];
  const second = ranked[1];
  const suf = policy.sufficiency;
  const topShare = informative.length ? top.matched.length / informative.length : 0;
  const near = ranked.filter((entry) => entry.score >= top.score * suf.within).length;
  const decisive = informative.length > 0 && top.score >= suf.minTopScore && topShare >= suf.minNeedShare &&
    (!second || second.score <= top.score * (1 - suf.margin) || near <= suf.maxRecommended);
  because.push(informative.length
    ? `the customer's words (${informative.map((term) => state.surfaces[term] ?? term).join(', ')}) ${decisive ? 'point clearly to' : 'do not yet single out'} a product (best score ${top.score.toFixed(2)}, ${near} close)`
    : 'the customer has not said what they need yet');

  const recommend = (): ConversationPlan => {
    const sole = !second || second.score <= top.score * (1 - suf.margin);
    const chosen = (sole ? [top] : ranked.filter((entry) => entry.score >= top.score * suf.within)).slice(0, suf.maxRecommended);
    const products: PlannedProduct[] = chosen.map((entry) => ({ ...entry, why: reasonFor(entry.item, entry.matched, state.surfaces, gate.claims.allowedClasses, policy) }));
    const needs = listWords([...new Set(products.flatMap((entry) => entry.why?.needs ?? []))]);
    state.pending = undefined;
    return plan('recommend', {
      products, showCards: { question: false, products: true, suggestions: true },
      message: fill(pick(products.length === 1 ? policy.templates.recommendOne : policy.templates.recommendMany, input.seed), { needs, title: products[0].item.title }),
      heading: policy.templates.headingRecommend, eyebrow: policy.templates.eyebrowRecommend,
    });
  };
  const show = (): ConversationPlan => {
    const list = (informative.length ? ranked : candidates.map((item) => ({ item, score: 0, matched: [] as string[] }))).slice(0, policy.show.maxItems);
    const needs = listWords(informative.map((term) => state.surfaces[term] ?? term));
    state.pending = undefined;
    return plan('show', {
      products: list, showCards: { question: false, products: true, suggestions: true },
      message: informative.length ? fill(pick(policy.templates.showNeeds, input.seed), { needs }) : pick(policy.templates.show, input.seed),
      heading: policy.templates.headingShow, eyebrow: policy.templates.eyebrowShow,
    });
  };

  if (forceShow) { because.push('the customer asked to see them, or named the product'); return show(); }
  if (decisive) { because.push('enough is known: recommending'); return recommend(); }
  if (browse) { because.push('the customer asked to browse: a short list, not a question'); return show(); }

  if (okf && !state.asked.includes(askedKind(okf))) { because.push('the release has a question that would help, and the customer has not said enough'); return ask(okf, false); }
  if (state.asked.length < policy.ask.maxPerConcept) {
    const facet = facetQuestion(candidates, { needTerms: state.terms, conceptWords, asked: state.asked, policy });
    if (facet) { because.push(`${candidates.length} products and nothing to tell them apart: asking what would narrow them most (${facet.factKey})`); return ask(facet, true); }
  }
  because.push('nothing to narrow by: showing a short list');
  return show();
}
