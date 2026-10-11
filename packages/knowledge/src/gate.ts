import type {
  ClaimClass,
  OkfConcept,
  OkfReleaseContent,
  OkfRevocationEvent,
  OkfVerificationRecord,
} from './contracts';

export type OkfResponseMode =
  | 'direct_results'
  | 'overview_then_ask'
  | 'clarify_then_search'
  | 'safety_then_diagnose'
  | 'project_journey'
  | 'service_intake'
  | 'evidence_answer'
  | 'operational_journey'
  | 'legacy_search'
  | 'knowledge_unavailable'
  | 'no_match';

export interface OkfGateInput {
  tenantId: string;
  environmentId: string;
  releaseId: string;
  message: string;
  knownFacts?: Record<string, unknown>;
  matchedConcepts?: Array<{ id: string; score: number; matchedBy?: string }>;
  intentCandidates?: string[];
  exactSku?: string;
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
    excludeCategoryIds: string[];
    groups?: Array<{ conceptId: string; label: string; categoryIds: string[]; excludeCategoryIds: string[]; maxItems: number }>;
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
  catalogHandling: {
    requiresLiveValidation: true;
    productStatus?: 'active' | 'discontinued' | 'poa';
    alternativeLanguage?: 'verified_equivalent' | 'possible_alternatives';
    nextAction?: 'quote';
  };
  claims: { allowedClasses: ClaimClass[]; disclaimers: string[] };
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

const OPERATIONAL_INTENTS = new Set([
  'order_status',
  'track_order',
  'account',
  'account_help',
  'return',
  'returns',
  'refund',
]);

const EVIDENCE_INTENTS = new Set(['warranty', 'installation', 'care', 'care_instructions']);
const PROBLEM_INTENTS = new Set(['problem', 'fault', 'leak', 'repair', 'troubleshoot', 'safety']);

function normalizedWords(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function hasExplicitProblemStatement(message: string): boolean {
  const lower = message.toLowerCase();
  if (/\b(?:no|not)\s+(?:a\s+)?(?:problem|fault|leak|damage)\b/.test(lower)) return false;
  return /\b(?:my|our|the)\s+(?:[a-z-]+\s+){0,4}(?:is|are|has|have|keeps?)\s+(?:leaking|broken|faulty|mouldy|sparking|smoking|burning)\b/.test(lower) ||
    /\bwater\s+(?:under|around|behind|through)\s+(?:my|our|the)\b/.test(lower) ||
    /\b(?:have|got|there(?:'s| is)|help(?:\s+me)?\s+with)\s+(?:a\s+)?(?:problem|fault|leak|damage)\b/.test(lower) ||
    /\b(?:fix|repair|troubleshoot)\s+(?:my|our|the)\s+[a-z-]+\b/.test(lower) ||
    /\b(?:mould|smoke|sparking)\s+(?:on|near|under|around)\s+(?:my|our|the|an?)\b/.test(lower);
}

function inferIntent(message: string): string[] {
  const lower = message.toLowerCase();
  const intents: string[] = [];
  if (/\b(where|track|status).{0,20}\border\b|\bmy order\b/.test(lower)) intents.push('order_status');
  if (/\breturn|refund\b/.test(lower)) intents.push('returns');
  if (/\bwarrant/.test(lower)) intents.push('warranty');
  if (/\binstall|installation|fit this\b/.test(lower)) intents.push('installation');
  if (/\bcare|clean safely|maintain/.test(lower)) intents.push('care');
  if (hasExplicitProblemStatement(message)) intents.push('problem');
  if (/\bquote|book|appointment|measure service/.test(lower)) intents.push('service_request');
  return intents;
}

function conceptDepth(conceptId: string): number {
  return conceptId.replace(/^concept:\/\//, '').split('/').length - 1;
}

function tenantFromConceptId(conceptId: string): string | undefined {
  return /^concept:\/\/([^/]+)\//.exec(conceptId)?.[1];
}

function findConcept(content: OkfReleaseContent, input: OkfGateInput): { concept?: OkfConcept; matchedBy: string } {
  const concepts = new Map(content.concepts.map((concept) => [concept.conceptId, concept]));
  for (const candidate of [...(input.matchedConcepts || [])].sort((a, b) => b.score - a.score)) {
    const concept = concepts.get(candidate.id);
    if (concept) return { concept, matchedBy: candidate.matchedBy || 'candidate' };
  }

  const message = input.message.toLowerCase().trim();
  const messageWords = new Set(normalizedWords(message));
  let best: { concept: OkfConcept; score: number; specificity: number; depth: number; matchedBy: string } | undefined;
  for (const concept of content.concepts) {
    const phrases = [concept.name, ...concept.synonyms, ...concept.customerPhrases];
    for (const phrase of phrases) {
      const words = normalizedWords(phrase);
      const normalized = words.join(' ');
      if (!normalized) continue;
      const messageNormalized = normalizedWords(message).join(' ');
      const exact = normalized === messageNormalized;
      // Token sequence matching avoids classifying “screwdriver” as “screw”
      // and avoids hyphenated adjectives such as “damage-free” as problems.
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const included = normalized.length > 2 && new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, 'i').test(messageNormalized);
      const coverage = words.length ? words.filter((word) => messageWords.has(word)).length / words.length : 0;
      const score = exact ? 1 : included ? 0.9 : coverage === 1 && words.length > 0 ? 0.75 : 0;
      const candidate = {
        concept,
        score,
        specificity: words.length,
        depth: conceptDepth(concept.conceptId),
        matchedBy: exact ? 'exact_phrase' : included ? 'phrase' : 'tokens',
      };
      if (
        score > 0 &&
        (!best || score > best.score ||
          (score === best.score && candidate.specificity > best.specificity) ||
          (score === best.score && candidate.specificity === best.specificity && candidate.depth > best.depth))
      ) best = candidate;
    }
  }
  return best ? { concept: best.concept, matchedBy: best.matchedBy } : { matchedBy: 'none' };
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

function scopedClaims(content: OkfReleaseContent, conceptId: string, now: Date): { allowed: ClaimClass[]; disclaimers: string[] } {
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
      disclaimers.push(`Relationship '${relationship.relationshipId}' is ${status}; compatibility, requirement, safety, and equivalence claims are not permitted.`);
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

function noMatch(input: OkfGateInput, reason: string, mode: OkfResponseMode = 'no_match'): OkfGateDecision {
  return {
    mode,
    retrieval: {
      permission: mode === 'legacy_search' ? 'allowed' : 'blocked',
      scope: [],
      categoryIds: [],
      excludeCategoryIds: [],
      groups: [],
      presentation: mode === 'legacy_search' ? 'list' : 'none',
    },
    recommendation: mode === 'legacy_search' ? 'category_examples' : 'blocked',
    commerce: BLOCKED_COMMERCE,
    catalogHandling: { requiresLiveValidation: true },
    claims: {
      allowedClasses: mode === 'legacy_search' ? ['catalog_fact'] : [],
      disclaimers: mode === 'legacy_search' ? ['OKF guidance is unavailable; only live catalog facts may be shown.'] : [],
    },
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

export function resolveOkfGate(content: OkfReleaseContent, input: OkfGateInput): OkfGateDecision {
  if (input.knowledgeAvailability && !input.knowledgeAvailability.available) {
    return input.knowledgeAvailability.required || input.knowledgeAvailability.failurePolicy === 'fail_closed'
      ? noMatch(input, 'knowledge_required_unavailable', 'knowledge_unavailable')
      : noMatch(input, 'knowledge_optional_unavailable', 'legacy_search');
  }

  const intents = [...new Set([...(input.intentCandidates || []), ...inferIntent(input.message)])];
  if (intents.some((intent) => OPERATIONAL_INTENTS.has(intent))) {
    const decision = noMatch(input, 'operational_intent', 'operational_journey');
    decision.claims.disclaimers = [];
    return decision;
  }

  const { concept: initialConcept, matchedBy } = findConcept(content, input);
  if (!initialConcept) return noMatch(input, 'concept_not_found');
  if (initialConcept.tenantId !== input.tenantId || tenantFromConceptId(initialConcept.conceptId) !== input.tenantId) {
    return noMatch(input, 'cross_tenant_concept_rejected');
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
  const claims = scopedClaims(content, concept.conceptId, now);
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
    claims: { allowedClasses: claims.allowed, disclaimers: claims.disclaimers },
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
      base.commerce = { ...BLOCKED_COMMERCE };
    }
    if (suppressClaims) {
      base.claims.allowedClasses = [];
      base.claims.disclaimers.push('Guidance for this topic is temporarily unavailable. Please contact a qualified professional.');
    }
    base.safety = { steps: [], blocksProducts: suppressRetrieval, guidanceUnavailable: suppressClaims };
    base.trace.reasonCodes.push('concept_revoked');
    return base;
  }

  const safetyIntent = concept.lens === 'problem' || concept.type === 'symptom' ||
    (hasExplicitProblemStatement(input.message) && intents.some((intent) => PROBLEM_INTENTS.has(intent)));
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
      base.commerce = BLOCKED_COMMERCE;
    }
    if (base.safety.guidanceUnavailable) {
      base.claims.disclaimers.push('Verified safety guidance is unavailable. Escalate to a qualified professional.');
    }
    base.trace.reasonCodes.push('safety_or_problem');
    return base;
  }

  if (concept.lens === 'service' || concept.type === 'service' || intents.includes('service_request')) {
    base.mode = 'service_intake';
    base.commerce = BLOCKED_COMMERCE;
    base.trace.reasonCodes.push('service_request');
    return base;
  }

  if (concept.lens === 'care' || intents.some((intent) => EVIDENCE_INTENTS.has(intent))) {
    const sourceRefs = verifiedEvidenceRefs(content, concept, now);
    const requestedClaimClass: ClaimClass | undefined = intents.includes('warranty')
      ? 'warranty'
      : intents.includes('installation')
      ? 'installation_step'
      : intents.includes('care') || concept.lens === 'care'
      ? 'care_safety'
      : undefined;
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
      base.claims.disclaimers.push('No verified source is linked to this concept in the pinned knowledge release.');
      base.trace.reasonCodes.push('verified_evidence_unavailable');
    } else {
      base.trace.reasonCodes.push('evidence_request');
    }
    return base;
  }

  if (concept.lens === 'project' || concept.type === 'project' || concept.type === 'room') {
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
    (input.forceShowResults || concept.discriminators.length === 0 || missingFacts.length > 0)
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
        excludeCategoryIds: group.searchScope.excludeCategoryIds,
        maxItems: concept.broadQueryPolicy!.maxItemsPerGroup,
      }] : [];
    });
    base.retrieval.presentation = concept.broadQueryPolicy.productRetrievalAllowed ? 'grouped_overview' : 'none';
    base.retrieval.maxItemsPerGroup = concept.broadQueryPolicy.maxItemsPerGroup;
    base.recommendation = 'category_examples';
    base.trace.reasonCodes.push(input.forceShowResults ? 'customer_declined_questions' : 'broad_product_concept');
  } else if (missingFacts.length === 0 || input.forceShowResults) {
    base.mode = 'direct_results';
    base.retrieval.permission = 'allowed';
    base.retrieval.scope = [concept.conceptId];
    base.retrieval.presentation = 'list';
    base.recommendation = 'matched_to_stated_needs';
    base.trace.reasonCodes.push(input.forceShowResults ? 'customer_declined_questions' : 'required_facts_known');
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
    base.claims.disclaimers.push('Compatibility must be verified before checkout.');
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
  return base;
}
