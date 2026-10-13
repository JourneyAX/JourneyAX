import { compareKnowledgeKeys } from './checksum';
import type {
  ClaimClass,
  OkfConcept,
  OkfReleaseContent,
  OkfResponseMode,
  OkfRevocationEvent,
  OkfVerificationRecord,
} from './contracts';
import {
  detectIntents,
  intentInGroup,
  renderOkfMessage,
  resolveOkfPolicy,
  tokenizeText,
  type ResolvedOkfPolicy,
} from './policy';

export interface OkfGateInput {
  tenantId: string;
  environmentId: string;
  releaseId: string;
  message: string;
  /** Customer language (BCP-47); selects the tenant's locale lexicon and wording. */
  locale?: string;
  knownFacts?: Record<string, unknown>;
  matchedConcepts?: Array<{ id: string; score: number; matchedBy?: string }>;
  intentCandidates?: string[];
  exactSku?: string;
  /** Live catalogue evidence that the message names something sold (supplied by the runtime, never assumed). */
  catalogueMatch?: boolean;
  candidateCount?: number;
  journeyStage?: string;
  declinedQuestions?: string[];
  activeRevocations?: OkfRevocationEvent[];
  now?: Date;
  forceShowResults?: boolean;
  commerceContext?: {
    productStatus?: 'active' | 'discontinued' | 'poa';
    hasVerifiedAlternative?: boolean;
  };
  knowledgeAvailability?: {
    available: boolean;
    required: boolean;
    failurePolicy: 'fail_closed' | 'enrichment_only';
  };
}

export interface OkfGateDecision {
  mode: OkfResponseMode;
  conceptId?: string;
  lens?: OkfConcept['lens'];
  journeyRef?: OkfConcept['journeyRef'];
  retrieval: {
    permission: 'allowed' | 'blocked';
    scope: string[];
    categoryIds: string[];
    /** Hierarchy scopes (department → group → category); a product is in scope when its path starts with one. */
    categoryPaths: string[][];
    excludeCategoryIds: string[];
    groups?: Array<{ conceptId: string; label: string; categoryIds: string[]; categoryPaths: string[][]; excludeCategoryIds: string[]; maxItems: number }>;
    presentation: 'grouped_overview' | 'list' | 'none';
    maxItemsPerGroup?: number;
  };
  recommendation: 'blocked' | 'category_examples' | 'matched_to_stated_needs' | 'verified_recommendation';
  clarification?: {
    blocking: boolean;
    factKey: string;
    questionRef: string;
    question: string;
    uiInputType: string;
    options: Array<{ value: string; label: string }>;
  };
  commerce: OkfConcept['commercePolicy'];
  /**
   * "Have you considered?" cross-sell from the matched concept. Always unverified: a suggestion never proves
   * compatibility, never marks an accessory as required, and adds no claim class.
   */
  suggestions?: Array<{
    conceptId: string; relationshipId: string; /** The suggested concept's own name. */ name: string; label: string; note: string; maxItems: number;
    categoryIds: string[]; categoryPaths: string[][]; excludeCategoryIds: string[]; status: 'unverified_cross_sell';
  }>;
  catalogHandling: {
    requiresLiveValidation: true;
    productStatus?: 'active' | 'discontinued' | 'poa';
    alternativeLanguage?: 'verified_equivalent' | 'possible_alternatives';
    nextAction?: 'quote';
  };
  /**
   * `disclaimers` is everything the agent must respect, including internal reasons. `notices` is the subset written for the
   * customer in plain language; it is the only part the runtime may show verbatim, and it never carries internal identifiers.
   */
  claims: { allowedClasses: ClaimClass[]; disclaimers: string[]; notices: string[] };
  evidence?: {
    conceptIds: string[];
    sourceRefs: string[];
    requestedClaimClass?: ClaimClass;
  };
  safety?: {
    steps: string[];
    blocksProducts: boolean;
    guidanceUnavailable?: boolean;
    guidance?: Array<{
      conceptId: string;
      title: string;
      instruction: string;
      sources: Array<{ sourceId: string; title: string }>;
    }>;
  };
  /** Resolved tenant/platform message templates, for runtime-level wording. */
  messages: Record<string, string>;
  trace: {
    matchedBy: string;
    depth: number;
    candidateCount?: number;
    missingFacts: string[];
    revocationsApplied: string[];
    releaseId: string;
    reasonCodes: string[];
  };
}

const BLOCKED_COMMERCE: OkfConcept['commercePolicy'] = {
  addToCart: 'blocked',
  checkout: 'blocked',
};

const blockedCommerce = (): OkfConcept['commercePolicy'] => ({ ...BLOCKED_COMMERCE });

function conceptDepth(conceptId: string): number {
  return conceptId.replace(/^concept:\/\//, '').split('/').length - 1;
}

function tenantFromConceptId(conceptId: string): string | undefined {
  return /^concept:\/\/([^/]+)\//.exec(conceptId)?.[1];
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function findConcept(
  content: OkfReleaseContent,
  input: OkfGateInput,
  policy: ResolvedOkfPolicy
): { concept?: OkfConcept; matchedBy: string } {
  const concepts = new Map(content.concepts.map((concept) => [concept.conceptId, concept]));
  for (const candidate of [...(input.matchedConcepts || [])].sort((a, b) => b.score - a.score)) {
    const concept = concepts.get(candidate.id);
    if (concept) return { concept, matchedBy: candidate.matchedBy || 'candidate' };
  }

  const messageWords = tokenizeText(input.message);
  const messageSet = new Set(messageWords);
  const messageNormalized = messageWords.join(' ');
  const { exact: exactScore, phrase: phraseScore, tokens: tokenScore, minimum, minPhraseLength } = policy.matching;
  interface Hit { concept: OkfConcept; score: number; specificity: number; depth: number; matchedBy: string }
  // Better = higher score, then the longer phrase, then the deeper concept.
  const better = (a: Hit, b: Hit | undefined) => !b || a.score > b.score ||
    (a.score === b.score && (a.specificity > b.specificity || (a.specificity === b.specificity && a.depth > b.depth)));
  const hits = new Map<string, Hit>();
  let best: Hit | undefined;
  for (const concept of content.concepts) {
    const phrases = [concept.name, ...concept.synonyms, ...concept.customerPhrases];
    for (const phrase of phrases) {
      const words = tokenizeText(phrase);
      const normalized = words.join(' ');
      if (!normalized) continue;
      const exact = normalized === messageNormalized;
      // Token-sequence containment avoids classifying a longer word (for example
      // a tool name) as a shorter product word, and never builds a pattern from data.
      const included = normalized.length >= minPhraseLength && containsSequence(messageWords, words);
      const coverage = words.length ? words.filter((word) => messageSet.has(word)).length / words.length : 0;
      const score = exact ? exactScore : included ? phraseScore : coverage === 1 && words.length > 0 ? tokenScore : 0;
      if (!(score > 0 && score >= minimum)) continue;
      const candidate: Hit = {
        concept, score, specificity: words.length,
        depth: conceptDepth(concept.conceptId), matchedBy: exact ? 'exact_phrase' : included ? 'phrase' : 'tokens',
      };
      if (better(candidate, hits.get(concept.conceptId))) hits.set(concept.conceptId, candidate);
      if (better(candidate, best)) best = candidate;
    }
  }
  if (!best) return { matchedBy: 'none' };

  // A customer who names two or more of a project's categories in one message is describing the project ("moisture-resistant linings
  // and waterproofing" is a wet-area job), so the project answers, with its questions and its overview, not one category alone.
  // A message that is exactly one concept's name or phrase is never overridden.
  if (best.matchedBy !== 'exact_phrase') {
    const named = new Set([...hits.values()].filter((hit) => hit.matchedBy === 'phrase').map((hit) => hit.concept.conceptId));
    if (named.size >= 2) {
      let chosen: { concept: OkfConcept; overlap: number; size: number } | undefined;
      for (const concept of content.concepts) {
        const groups = concept.broadQueryPolicy?.groupConceptIds;
        const projectLike = concept.lens === 'project' || concept.type === 'project' || concept.type === 'room';
        if (!projectLike || !groups?.length) continue;
        const overlap = groups.filter((id) => named.has(id)).length;
        if (overlap < 2) continue;
        if (!chosen || overlap > chosen.overlap || (overlap === chosen.overlap && groups.length < chosen.size)) chosen = { concept, overlap, size: groups.length };
      }
      if (chosen) return { concept: chosen.concept, matchedBy: 'project_categories' };
    }
  }
  return { concept: best.concept, matchedBy: best.matchedBy };
}

function descendantsOf(content: OkfReleaseContent, parentId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const relationship of content.relationships) {
    if (relationship.type !== 'child_of') continue;
    children.set(relationship.to, [...(children.get(relationship.to) || []), relationship.from]);
  }
  const descendants = new Set<string>();
  const visit = (id: string) => {
    for (const child of children.get(id) || []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      visit(child);
    }
  };
  visit(parentId);
  return descendants;
}

function effectiveVerification(
  record: OkfVerificationRecord | undefined,
  now: Date
): 'unverified' | 'in_review' | 'verified' | 'expired' {
  if (!record) return 'unverified';
  if (record.staleAfter && new Date(record.staleAfter) <= now) return 'expired';
  return record.status;
}

function scopedClaims(content: OkfReleaseContent, conceptId: string, now: Date, policy: ResolvedOkfPolicy): { allowed: ClaimClass[]; disclaimers: string[] } {
  const verifications = new Map(content.verifications.map((record) => [record.recordId, record]));
  const allowed = new Set<ClaimClass>(['suggestion']);
  const disclaimers: string[] = [];
  for (const relationship of content.relationships.filter((candidate) => candidate.from === conceptId)) {
    const status = effectiveVerification(
      relationship.verificationRef ? verifications.get(relationship.verificationRef) : undefined,
      now
    );
    if (status === 'verified') {
      for (const claim of relationship.claimClasses) allowed.add(claim);
    } else if (relationship.claimClasses.length) {
      disclaimers.push(renderOkfMessage(policy.messages, 'relationship_unverified', { relationshipId: relationship.relationshipId, status }));
    }
  }
  return { allowed: [...allowed], disclaimers };
}

/**
 * Resolves customer-facing safety instructions only through a verified,
 * source-backed relationship from the matched concept to each referenced
 * safety step. A stepRef by itself is routing metadata, not permission to
 * present the referenced prose as verified guidance.
 */
function verifiedSafetyGuidance(
  content: OkfReleaseContent,
  concept: OkfConcept,
  now: Date
): NonNullable<NonNullable<OkfGateDecision['safety']>['guidance']> {
  const concepts = new Map(content.concepts.map((entry) => [entry.conceptId, entry]));
  const sources = new Map(content.sources.map((entry) => [entry.sourceId, entry]));
  const verifications = new Map(content.verifications.map((entry) => [entry.recordId, entry]));

  return concept.safety.stepRefs.flatMap((stepRef) => {
    const step = concepts.get(stepRef);
    if (!step || !['safety_step', 'diagnostic_step', 'escalation'].includes(step.type)) return [];

    const relationship = content.relationships.find((candidate) =>
      candidate.from === concept.conceptId &&
      candidate.to === stepRef &&
      candidate.claimClasses.includes('safety_instruction')
    );
    const verification = relationship?.verificationRef
      ? verifications.get(relationship.verificationRef)
      : undefined;
    if (!relationship || effectiveVerification(verification, now) !== 'verified') return [];

    const sourceIds = [...new Set([
      ...relationship.sourceRefs,
      ...(verification?.sourceRefs || []),
      ...step.evidenceRefs,
    ])];
    const verifiedSources = sourceIds.flatMap((sourceId) => {
      const source = sources.get(sourceId);
      return source ? [{ sourceId, title: source.title }] : [];
    });
    if (verifiedSources.length === 0) return [];

    return [{
      conceptId: step.conceptId,
      title: step.name,
      instruction: step.description,
      sources: verifiedSources,
    }];
  });
}

function verifiedEvidenceRefs(content: OkfReleaseContent, concept: OkfConcept, now: Date): string[] {
  const verifications = new Map(content.verifications.map((entry) => [entry.recordId, entry]));
  const refs = new Set<string>();

  if (concept.verificationRef) {
    const verification = verifications.get(concept.verificationRef);
    if (effectiveVerification(verification, now) === 'verified') {
      for (const sourceRef of [...concept.evidenceRefs, ...(verification?.sourceRefs || [])]) refs.add(sourceRef);
    }
  }

  for (const relationship of content.relationships.filter((candidate) => candidate.from === concept.conceptId)) {
    const verification = relationship.verificationRef
      ? verifications.get(relationship.verificationRef)
      : undefined;
    if (effectiveVerification(verification, now) !== 'verified') continue;
    for (const sourceRef of [...relationship.sourceRefs, ...(verification?.sourceRefs || [])]) refs.add(sourceRef);
  }
  return [...refs];
}

/** Records a policy message for the agent and, because policy messages are customer-written, for the customer too. */
function addNotice(claims: OkfGateDecision['claims'], policy: ResolvedOkfPolicy, key: string): void {
  const text = renderOkfMessage(policy.messages, key);
  claims.disclaimers.push(text);
  if (text && !claims.notices.includes(text)) claims.notices.push(text);
}

function noMatch(input: OkfGateInput, reason: string, mode: OkfResponseMode = 'no_match', policy: ResolvedOkfPolicy = resolveOkfPolicy()): OkfGateDecision {
  return {
    mode,
    retrieval: {
      permission: mode === 'legacy_search' ? 'allowed' : 'blocked',
      scope: [],
      categoryIds: [],
      categoryPaths: [],
      excludeCategoryIds: [],
      groups: [],
      presentation: mode === 'legacy_search' ? 'list' : 'none',
    },
    recommendation: mode === 'legacy_search' ? 'category_examples' : 'blocked',
    commerce: blockedCommerce(),
    catalogHandling: { requiresLiveValidation: true },
    claims: {
      allowedClasses: mode === 'legacy_search' ? ['catalog_fact'] : [],
      disclaimers: mode === 'legacy_search' ? [renderOkfMessage(policy.messages, 'legacy_catalog_only')] : [],
      notices: mode === 'legacy_search' ? [renderOkfMessage(policy.messages, 'legacy_catalog_only')] : [],
    },
    messages: policy.messages,
    trace: {
      matchedBy: 'none',
      depth: 0,
      missingFacts: [],
      revocationsApplied: [],
      releaseId: input.releaseId,
      reasonCodes: [reason],
    },
  };
}

export type UncoveredRequestKind = 'problem' | 'technical' | 'shopping' | 'operational' | 'unknown';

/** Classifies a request that matched no governed concept. Hazards first, so nothing can outrank safety. */
export function classifyUncoveredRequest(input: OkfGateInput, policy: ResolvedOkfPolicy, intents: string[]): UncoveredRequestKind {
  if (intentInGroup(policy, 'problem', intents)) return 'problem';
  if (intentInGroup(policy, 'operational', intents)) return 'operational';
  if (intentInGroup(policy, 'technical', intents)) return 'technical';
  if (input.exactSku || input.catalogueMatch || intentInGroup(policy, 'shopping', intents)) return 'shopping';
  return 'unknown';
}

/**
 * No governed concept matched. The result depends on what kind of request this is, never on a blanket default:
 *  - problem/safety → escalate to a qualified professional; no products, no cart, no checkout, no invented guidance
 *  - operational    → the operational journey
 *  - technical      → no claims; clarify or refer to a specialist; no products
 *  - shopping       → only if the release explicitly opts in: live-validated catalogue facts, no technical claims,
 *                     cart/checkout limited to the configured policy (and still subject to per-product checks)
 *  - unknown        → clarify; nothing is retrieved
 */
function uncoveredDecision(input: OkfGateInput, policy: ResolvedOkfPolicy, intents: string[]): OkfGateDecision {
  const kind = classifyUncoveredRequest(input, policy, intents);
  const tag = (decision: OkfGateDecision, ...codes: string[]) => { decision.trace.reasonCodes.push(...codes); return decision; };
  if (kind === 'problem') {
    const decision = noMatch(input, 'concept_not_found', 'safety_then_diagnose', policy);
    decision.safety = { steps: [], blocksProducts: true, guidanceUnavailable: true, guidance: [] };
    decision.claims = { allowedClasses: [], disclaimers: [], notices: [] };
    return tag(decision, 'uncovered_problem');
  }
  if (kind === 'operational') {
    const decision = noMatch(input, 'operational_intent', 'operational_journey', policy);
    decision.claims.disclaimers = [];
    decision.claims.notices = [];
    return decision;
  }
  if (kind === 'technical') {
    const decision = noMatch(input, 'concept_not_found', 'no_match', policy);
    decision.claims.disclaimers = [];
    decision.claims.notices = [];
    addNotice(decision.claims, policy, 'uncovered_technical_unverified');
    return tag(decision, 'uncovered_technical');
  }
  if (kind === 'shopping' && policy.coverage.uncoveredShopping.mode === 'catalogue_only') {
    const decision = noMatch(input, 'concept_not_found', 'legacy_search', policy);
    decision.commerce = { ...policy.coverage.uncoveredShopping.commerce };
    decision.claims = { allowedClasses: ['catalog_fact'], disclaimers: [], notices: [] };
    addNotice(decision.claims, policy, 'uncovered_catalogue_only');
    return tag(decision, 'uncovered_shopping_catalogue_only');
  }
  return tag(noMatch(input, 'concept_not_found', 'no_match', policy), kind === 'shopping' ? 'uncovered_shopping_blocked' : 'uncovered_unknown');
}

export function resolveOkfGate(content: OkfReleaseContent, input: OkfGateInput): OkfGateDecision {
  const policy = resolveOkfPolicy(content?.policy, input.locale);
  if (input.knowledgeAvailability && !input.knowledgeAvailability.available) {
    return input.knowledgeAvailability.required || input.knowledgeAvailability.failurePolicy === 'fail_closed'
      ? noMatch(input, 'knowledge_required_unavailable', 'knowledge_unavailable', policy)
      : noMatch(input, 'knowledge_optional_unavailable', 'legacy_search', policy);
  }

  const detectedIntents = detectIntents(input.message, policy).intents;
  const intents = [...new Set([...(input.intentCandidates || []), ...detectedIntents])];
  const forceShow = Boolean(input.forceShowResults) || detectedIntents.includes('force_show');
  // A safety problem outranks an operational request in the same message: the operational branch is taken
  // only when the message carries no problem intent, or when no governed concept exists to enforce safety.
  const operational = intentInGroup(policy, 'operational', intents);
  const operationalDecision = () => {
    const decision = noMatch(input, 'operational_intent', 'operational_journey', policy);
    decision.claims.disclaimers = [];
    decision.claims.notices = [];
    return decision;
  };
  if (operational && !intentInGroup(policy, 'problem', intents)) return operationalDecision();

  const { concept: initialConcept, matchedBy } = findConcept(content, input, policy);
  if (!initialConcept) return uncoveredDecision(input, policy, intents);
  // A product or project concept never answers a problem or hazard message ("my heater is smoking" must not become a
  // heater listing). Only a concept authored for the problem lens may handle it; otherwise the request escalates.
  if (initialConcept.lens !== 'problem' && intentInGroup(policy, 'problem', intents)) {
    const escalation = uncoveredDecision({ ...input, exactSku: undefined, catalogueMatch: false }, policy, intents);
    escalation.trace.reasonCodes.push('problem_without_problem_concept');
    return escalation;
  }
  if (initialConcept.tenantId !== input.tenantId || tenantFromConceptId(initialConcept.conceptId) !== input.tenantId) {
    return noMatch(input, 'cross_tenant_concept_rejected', 'no_match', policy);
  }

  const concepts = new Map(content.concepts.map((concept) => [concept.conceptId, concept]));
  const knownFacts = input.knownFacts || {};
  let concept = initialConcept;
  // A captured discriminator may deterministically narrow the concept before deciding the mode.
  for (const discriminator of concept.discriminators) {
    const value = knownFacts[discriminator.factKey];
    const target = value === undefined ? undefined : discriminator.valueMap[String(value)];
    if (target && concepts.has(target)) concept = concepts.get(target)!;
  }

  const appliedRevocations: string[] = [];
  let suppressClaims = false;
  let suppressRetrieval = false;
  for (const revocation of input.activeRevocations || []) {
    if (revocation.tenantId !== input.tenantId || revocation.environmentId !== input.environmentId) continue;
    if (revocation.expiresAt <= (input.now || new Date())) continue;
    const suppressed = new Set(revocation.conceptIds);
    if (revocation.cascade === 'descendants') {
      for (const root of revocation.conceptIds) for (const child of descendantsOf(content, root)) suppressed.add(child);
    }
    // Check both the customer-matched parent and a discriminator-narrowed child.
    // Otherwise a revoked broad concept can be bypassed simply by answering its
    // narrowing question in the same turn.
    if (suppressed.has(initialConcept.conceptId) || suppressed.has(concept.conceptId)) {
      suppressClaims ||= revocation.effect.suppressClaims;
      suppressRetrieval ||= revocation.effect.suppressRetrieval;
      appliedRevocations.push(revocation.revocationId);
    }
  }

  const now = input.now || new Date();
  const claims = scopedClaims(content, concept.conceptId, now, policy);
  const declined = new Set(input.declinedQuestions || []);
  const missingFacts = concept.discriminators
    .map((entry) => entry.factKey)
    .filter((factKey) => knownFacts[factKey] === undefined || knownFacts[factKey] === null || knownFacts[factKey] === '');
  const nextDiscriminator = concept.discriminators.find(
    (entry) => missingFacts.includes(entry.factKey) && !declined.has(entry.questionRef) && !declined.has(entry.factKey)
  );
  const factDefinition = nextDiscriminator
    ? content.factRegistry.find((fact) => fact.factKey === nextDiscriminator.factKey && fact.questionRef === nextDiscriminator.questionRef)
    : undefined;

  const base: OkfGateDecision = {
    mode: 'no_match',
    conceptId: concept.conceptId,
    lens: concept.lens,
    journeyRef: concept.journeyRef,
    retrieval: {
      permission: 'blocked',
      scope: [],
      categoryIds: concept.searchScope.catalogCategoryIds,
      categoryPaths: concept.searchScope.catalogCategoryPaths ?? [],
      excludeCategoryIds: concept.searchScope.excludeCategoryIds,
      groups: [],
      presentation: 'none',
    },
    recommendation: 'blocked',
    commerce: { ...concept.commercePolicy },
    catalogHandling: {
      requiresLiveValidation: true,
      productStatus: input.commerceContext?.productStatus,
    },
    claims: { allowedClasses: claims.allowed, disclaimers: claims.disclaimers, notices: [] },
    messages: policy.messages,
    trace: {
      matchedBy,
      depth: conceptDepth(concept.conceptId),
      candidateCount: input.candidateCount,
      missingFacts,
      revocationsApplied: appliedRevocations,
      releaseId: input.releaseId,
      reasonCodes: [],
    },
  };

  if (suppressClaims || suppressRetrieval) {
    base.mode = concept.lens === 'problem' || concept.riskClass === 'safety_critical' ? 'safety_then_diagnose' : 'no_match';
    if (suppressRetrieval) {
      base.retrieval.permission = 'blocked';
      base.commerce = blockedCommerce();
    }
    if (suppressClaims) {
      base.claims.allowedClasses = [];
      addNotice(base.claims, policy, 'guidance_temporarily_unavailable');
    }
    base.safety = { steps: [], blocksProducts: suppressRetrieval, guidanceUnavailable: suppressClaims };
    base.trace.reasonCodes.push('concept_revoked');
    return base;
  }

  const safetyIntent = concept.lens === 'problem' || concept.type === 'symptom' ||
    intentInGroup(policy, 'problem', detectedIntents);
  if (safetyIntent) {
    const guidance = verifiedSafetyGuidance(content, concept, now);
    const hasCompleteGuidance = concept.safety.stepRefs.length > 0 && guidance.length === concept.safety.stepRefs.length;
    base.mode = 'safety_then_diagnose';
    base.safety = {
      steps: concept.safety.stepRefs,
      blocksProducts: concept.safety.blocksProducts,
      guidance: hasCompleteGuidance ? guidance : [],
      guidanceUnavailable:
        !base.claims.allowedClasses.includes('safety_instruction') || !hasCompleteGuidance,
    };
    if (base.safety.blocksProducts || base.safety.guidanceUnavailable) {
      base.retrieval.permission = 'blocked';
      base.commerce = blockedCommerce();
    }
    if (base.safety.guidanceUnavailable) {
      addNotice(base.claims, policy, 'safety_unavailable_customer');
    }
    base.trace.reasonCodes.push('safety_or_problem');
    return base;
  }

  if (concept.lens === 'service' || concept.type === 'service' || intentInGroup(policy, 'service', intents)) {
    base.mode = 'service_intake';
    base.commerce = blockedCommerce();
    base.trace.reasonCodes.push('service_request');
    return base;
  }

  if (concept.lens === 'care' || intentInGroup(policy, 'evidence', intents)) {
    const sourceRefs = verifiedEvidenceRefs(content, concept, now);
    const requestedClaimClass: ClaimClass | undefined = policy.evidenceClaims.find((entry) =>
      (entry.intent && intents.includes(entry.intent)) || (entry.lens && entry.lens === concept.lens)
    )?.claimClass;
    base.mode = 'evidence_answer';
    base.evidence = {
      conceptIds: [concept.conceptId],
      sourceRefs,
      requestedClaimClass,
    };
    base.retrieval.permission = sourceRefs.length > 0 ? 'allowed' : 'blocked';
    base.retrieval.scope = [concept.conceptId];
    base.retrieval.presentation = sourceRefs.length > 0 ? 'list' : 'none';
    base.recommendation = 'blocked';
    if (sourceRefs.length === 0) {
      addNotice(base.claims, policy, 'evidence_unavailable');
      base.trace.reasonCodes.push('verified_evidence_unavailable');
    } else {
      base.trace.reasonCodes.push('evidence_request');
    }
    return base;
  }

  // A project owned by an authored journey hands off to that journey. A project with none is served by the gate
  // itself: it asks its missing questions, then previews its member categories.
  const projectLike = concept.lens === 'project' || concept.type === 'project' || concept.type === 'room';
  // A project with neither an authored journey nor a preview policy keeps the original behaviour: hand off.
  const servedByGate = projectLike && !concept.journeyRef && Boolean(concept.broadQueryPolicy);
  if (projectLike && !servedByGate) {
    base.mode = 'project_journey';
    base.retrieval.permission = 'blocked';
    base.trace.reasonCodes.push('project_or_room');
  } else if (input.exactSku) {
    base.mode = 'direct_results';
    base.retrieval.permission = 'allowed';
    base.retrieval.scope = [concept.conceptId];
    base.retrieval.presentation = 'list';
    base.recommendation = input.exactSku ? 'matched_to_stated_needs' : 'matched_to_stated_needs';
    base.trace.reasonCodes.push('exact_sku');
  } else if (concept.compatibilitySensitive && nextDiscriminator?.clarifyFirst) {
    // A merchant's blocking compatibility question takes precedence over a
    // broad overview, including when the customer asks to skip questions.
    base.mode = 'clarify_then_search';
    base.retrieval.permission = 'blocked';
    base.commerce = {
      addToCart: concept.riskClass === 'standard' ? 'allowed_with_warning' : 'blocked',
      checkout: concept.riskClass === 'safety_critical' ? 'requires_professional_confirmation' : 'requires_compatibility_resolution',
    };
    base.trace.reasonCodes.push('compatibility_fact_missing');
  } else if (
    concept.broadQueryPolicy &&
    (forceShow || concept.discriminators.length === 0 || missingFacts.length > 0 || servedByGate)
  ) {
    // “Just show me” means show a safe, grouped overview now; it does not turn
    // a low-specificity query into a fully matched recommendation.
    base.mode = 'overview_then_ask';
    base.retrieval.permission = concept.broadQueryPolicy.productRetrievalAllowed ? 'allowed' : 'blocked';
    base.retrieval.scope = concept.broadQueryPolicy.groupConceptIds;
    base.retrieval.groups = concept.broadQueryPolicy.groupConceptIds.flatMap((conceptId) => {
      const group = concepts.get(conceptId);
      return group ? [{
        conceptId,
        label: group.name,
        categoryIds: group.searchScope.catalogCategoryIds,
        categoryPaths: group.searchScope.catalogCategoryPaths ?? [],
        excludeCategoryIds: group.searchScope.excludeCategoryIds,
        maxItems: concept.broadQueryPolicy!.maxItemsPerGroup,
      }] : [];
    });
    base.retrieval.presentation = concept.broadQueryPolicy.productRetrievalAllowed ? 'grouped_overview' : 'none';
    base.retrieval.maxItemsPerGroup = concept.broadQueryPolicy.maxItemsPerGroup;
    base.recommendation = 'category_examples';
    base.trace.reasonCodes.push(forceShow ? 'customer_declined_questions' : 'broad_product_concept');
  } else if (missingFacts.length === 0 || forceShow) {
    base.mode = 'direct_results';
    base.retrieval.permission = 'allowed';
    base.retrieval.scope = [concept.conceptId];
    base.retrieval.presentation = 'list';
    base.recommendation = 'matched_to_stated_needs';
    base.trace.reasonCodes.push(forceShow ? 'customer_declined_questions' : 'required_facts_known');
  } else {
    base.trace.reasonCodes.push('no_policy_match');
  }

  if (nextDiscriminator && factDefinition && base.mode !== 'direct_results') {
    base.clarification = {
      blocking: base.mode === 'clarify_then_search',
      factKey: factDefinition.factKey,
      questionRef: factDefinition.questionRef,
      question: factDefinition.question,
      uiInputType: factDefinition.uiInputType,
      options: factDefinition.options || (factDefinition.allowedValues || []).map((value) => ({ value, label: value })),
    };
  }

  if (concept.riskClass === 'compatibility' && base.recommendation !== 'blocked') {
    addNotice(base.claims, policy, 'compatibility_unverified');
  }
  if (concept.riskClass === 'safety_critical') {
    if (base.commerce.checkout !== 'blocked') {
      base.commerce.checkout = 'requires_professional_confirmation';
    }
  }
  if (input.commerceContext?.productStatus === 'discontinued') {
    base.catalogHandling.alternativeLanguage = input.commerceContext.hasVerifiedAlternative
      ? 'verified_equivalent'
      : 'possible_alternatives';
  }
  if (input.commerceContext?.productStatus === 'poa') {
    base.commerce.addToCart = 'blocked';
    base.catalogHandling.nextAction = 'quote';
  }
  // A suitability, compliance or compatibility question about something we can list is answered with the listing and a
  // plain statement that no verified information supports the technical claim; the listing itself asserts nothing.
  if (
    intentInGroup(policy, 'technical', intents) && base.retrieval.permission === 'allowed' &&
    !base.claims.allowedClasses.includes('compatibility')
  ) {
    addNotice(base.claims, policy, 'technical_requirement_unverified');
    base.trace.reasonCodes.push('technical_requirement_unverified');
  }
  if (servedByGate) base.trace.reasonCodes.push('project_served_by_gate');
  if (base.retrieval.permission === 'allowed') {
    const suggestions = suggestionsFor(content, concept, policy);
    if (suggestions.length) base.suggestions = suggestions;
  }
  return base;
}

function suggestionsFor(content: OkfReleaseContent, concept: OkfConcept, policy: ResolvedOkfPolicy): NonNullable<OkfGateDecision['suggestions']> {
  if (policy.suggestions.max === 0) return [];
  const concepts = new Map(content.concepts.map((entry) => [entry.conceptId, entry]));
  return content.relationships
    .filter((relationship) => relationship.type === 'cross_sell' && relationship.from === concept.conceptId)
    .sort((a, b) => compareKnowledgeKeys(a.relationshipId, b.relationshipId))
    .flatMap((relationship) => {
      const target = concepts.get(relationship.to);
      if (!target || target.lifecycle.status === 'retired' || target.tenantId !== concept.tenantId) return [];
      // Only something a customer could actually buy is worth suggesting: never a problem, care, service or professional-only item.
      if (target.lens !== 'product' || target.riskClass === 'safety_critical' || target.commercePolicy.addToCart === 'blocked') return [];
      return [{
        conceptId: target.conceptId, relationshipId: relationship.relationshipId, name: target.name, maxItems: policy.suggestions.itemsPerGroup,
        label: relationship.customerLabel || renderOkfMessage(policy.messages, 'cross_sell_label'),
        note: renderOkfMessage(policy.messages, 'cross_sell_note'),
        categoryIds: target.searchScope.catalogCategoryIds, categoryPaths: target.searchScope.catalogCategoryPaths ?? [],
        excludeCategoryIds: target.searchScope.excludeCategoryIds,
        status: 'unverified_cross_sell' as const,
      }];
    })
    .slice(0, policy.suggestions.max);
}
