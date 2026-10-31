import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { OkfReleaseContent, OkfConcept } from '@journeyax/knowledge';

/**
 * Builds a compact, cacheable business profile block from the pack profile and OKF release.
 * Injected into the AI's instructions so it knows what the business sells, tone, and scope.
 */
export function formatBusinessProfile(release: BusinessPackRelease, okfContent?: OkfReleaseContent | null): string {
  const profile: Record<string, any> = (release.profile as any) || {};
  const companyName = profile.companyName || release.manifest?.name || 'Customer Consultant';
  const lines: string[] = [];

  lines.push(`Business: ${companyName}`);
  if (profile.industry) lines.push(`Industry: ${profile.industry}`);
  if (profile.primaryLocale) lines.push(`Primary Locale: ${profile.primaryLocale}`);
  if (profile.primaryCurrency) lines.push(`Primary Currency: ${profile.primaryCurrency}`);
  if (profile.tagline) lines.push(`Scope: ${profile.tagline}`);

  const sellingScope = (profile as any).sellingScope;
  if (Array.isArray(sellingScope?.inScope) && sellingScope.inScope.length > 0) {
    lines.push(`What is sold: ${sellingScope.inScope.join(', ')}`);
  }
  if (Array.isArray(sellingScope?.outOfScope) && sellingScope.outOfScope.length > 0) {
    lines.push(`What is NOT sold: ${sellingScope.outOfScope.join(', ')}`);
  }
  if ((profile as any).tone) lines.push(`Tone: ${(profile as any).tone}`);

  const policy = okfContent?.policy;
  if (Array.isArray((policy as any)?.customerServiceRules) && (policy as any).customerServiceRules.length > 0) {
    lines.push(`Service Principles:\n${(policy as any).customerServiceRules.map((r: string) => `- ${r}`).join('\n')}`);
  }

  return `<business_profile>\n${lines.join('\n')}\n</business_profile>`;
}

export interface ExtractOkfNotesOptions {
  conceptId?: string;
  customerQuestion: string;
  facts?: Record<string, any>;
  maxChars?: number;
  agentRelationshipTypes?: string[] | Set<string>;
}

/**
 * Default relationship types exposed to the agent loop.
 * By default, every relationship type in the OKF schema is included except 'child_of' (which is structural hierarchy).
 */
export const DEFAULT_AGENT_RELATIONSHIP_TYPES: string[] = [
  'relevant_to',
  'solves',
  'diagnoses',
  'requires',
  'compatible_with',
  'incompatible_with',
  'alternative_to',
  'installed_with',
  'care_for',
  'document_for',
  'escalates_to',
  'cross_sell',
];

/**
 * Resolves the allowed OKF relationship types for the agent.
 * Precedence:
 * 1. Explicit override passed directly (per invocation or agent configuration)
 * 2. Agent configuration from business pack / release
 * 3. Tenant OKF policy: okfContent.policy.agentRelationshipTypes
 * 4. Default: all standard OKF relationship types except 'child_of'
 */
export function resolveAgentRelationshipTypes(
  okfContent?: OkfReleaseContent | null,
  overrideTypes?: string[] | Set<string>,
  agentConfig?: { agentRelationshipTypes?: string[] } | null
): Set<string> {
  if (overrideTypes) {
    return overrideTypes instanceof Set ? overrideTypes : new Set(overrideTypes);
  }
  if (Array.isArray(agentConfig?.agentRelationshipTypes) && agentConfig.agentRelationshipTypes.length > 0) {
    return new Set(agentConfig.agentRelationshipTypes);
  }
  const policyTypes = (okfContent as any)?.policy?.agentRelationshipTypes;
  if (Array.isArray(policyTypes) && policyTypes.length > 0) {
    return new Set(policyTypes);
  }
  return new Set(DEFAULT_AGENT_RELATIONSHIP_TYPES);
}

/**
 * @deprecated Use resolveAgentRelationshipTypes() or DEFAULT_AGENT_RELATIONSHIP_TYPES.
 */
export const OKF_ALLOWED_RELATIONSHIP_TYPES = new Set(DEFAULT_AGENT_RELATIONSHIP_TYPES);

/**
 * Finds relevant OKF concepts for a given question or conceptId.
 */
export function findRelevantOkfConcepts(
  okfContent: OkfReleaseContent | null | undefined,
  options: { conceptId?: string; customerQuestion: string; maxConcepts?: number }
): OkfConcept[] {
  if (!okfContent) return [];
  const maxConcepts = options.maxConcepts || 4;
  const concepts: OkfConcept[] = okfContent.concepts || [];
  const lowerQ = options.customerQuestion.toLowerCase();

  const activeConcepts: OkfConcept[] = [];
  if (options.conceptId) {
    const primary = concepts.find((c) => c.conceptId === options.conceptId);
    if (primary) activeConcepts.push(primary);
  }

  for (const c of concepts) {
    if (activeConcepts.some((ac) => ac.conceptId === c.conceptId)) continue;
    const nameMatch = Boolean(c.name && lowerQ.includes(c.name.toLowerCase()));
    const synMatch = Boolean((c.synonyms || []).some((s) => lowerQ.includes(s.toLowerCase())));
    const phraseMatch = Boolean((c.customerPhrases || []).some((p) => lowerQ.includes(p.toLowerCase())));
    if (nameMatch || synMatch || phraseMatch) {
      activeConcepts.push(c);
      if (activeConcepts.length >= maxConcepts) break;
    }
  }

  return activeConcepts;
}

/**
 * Extracts relevant OKF notes on demand from the tenant's PINNED release:
 * concepts, project recipes, family notes, relationships (what goes with what), and install/care notes.
 * Capped by maxChars (default 4000) and delimited inside <business_knowledge>.
 */
export function extractRelevantOkfNotes(
  okfContent: OkfReleaseContent | null | undefined,
  options: ExtractOkfNotesOptions
): string {
  if (!okfContent) return '';
  const maxChars = options.maxChars || 4000;
  const concepts: OkfConcept[] = okfContent.concepts || [];
  const relationships = okfContent.relationships || [];

  const activeConcepts = findRelevantOkfConcepts(okfContent, {
    conceptId: options.conceptId,
    customerQuestion: options.customerQuestion,
    maxConcepts: 4,
  });

  const notes: string[] = [];
  let currentChars = 0;

  const escapeClosingTag = (str: string): string =>
    str.replace(/<\/business_knowledge>/gi, '&lt;/business_knowledge&gt;');

  const addNote = (line: string): boolean => {
    const sanitized = escapeClosingTag(line);
    if (currentChars + sanitized.length + 1 > maxChars) return false;
    notes.push(sanitized);
    currentChars += sanitized.length + 1;
    return true;
  };

  // 1. Concept definitions and risk classes
  for (const c of activeConcepts) {
    addNote(`[concept: ${c.name}] (id: ${c.conceptId}, risk: ${c.riskClass || 'standard'}): ${c.description || ''}`);
    if (Array.isArray(c.synonyms) && c.synonyms.length > 0) {
      addNote(`[synonyms: ${c.name}]: ${c.synonyms.join(', ')}`);
    }
  }

  // 2. Relationships (policy-driven agent relationship types, excluding child_of by default)
  const conceptMap = new Map<string, OkfConcept>(concepts.map((c) => [c.conceptId, c]));
  const activeIds = new Set<string>(activeConcepts.map((c) => c.conceptId));
  const allowedRelationshipTypes = resolveAgentRelationshipTypes(
    okfContent,
    options.agentRelationshipTypes
  );

  const relevantRels = relationships.filter(
    (r) => (activeIds.has(r.from) || activeIds.has(r.to)) && allowedRelationshipTypes.has(r.type)
  );

  for (const r of relevantRels) {
    const fromConcept = conceptMap.get(r.from);
    const toConcept = conceptMap.get(r.to);
    if (!toConcept) continue;

    const label = r.customerLabel || `${r.type} ${toConcept.name}`;
    addNote(
      `[relationship: ${r.type} -> ${toConcept.name}] (source: ${r.relationshipId}): ${fromConcept?.name || r.from} ${label}`
    );
  }

  // 3. Evidence / sources if linked
  for (const c of activeConcepts) {
    const refs = (c as any).evidenceRefs || (c as any).sourceRefs || [];
    for (const refId of refs) {
      const src = (okfContent.sources || []).find((s) => s.sourceId === refId);
      if (src) {
        const uri = (src as any).uri || (src as any).officialUri;
        addNote(`[source: ${src.sourceId}] (${src.kind}): ${src.title} ${uri ? `(${uri})` : ''}`);
      }
    }
  }

  // 4. Flow fields ONLY as hints ("good questions to ask", never forced)
  const factRegistry = (okfContent.factRegistry || (okfContent as any).facts || []) as Array<{ factKey: string; question?: string }>;
  const factMap = new Map(factRegistry.map((f) => [f.factKey, f]));
  for (const c of activeConcepts) {
    const hintQuestions: string[] = [];
    if (Array.isArray(c.discriminators)) {
      for (const d of c.discriminators) {
        const f = factMap.get(d.factKey);
        if (f?.question && !hintQuestions.includes(f.question)) {
          hintQuestions.push(f.question);
        }
      }
    }
    if (Array.isArray(c.requiredFacts)) {
      for (const rf of c.requiredFacts) {
        const f = factMap.get(rf.factKey);
        if (f?.question && !hintQuestions.includes(f.question)) {
          hintQuestions.push(f.question);
        }
      }
    }
    if (hintQuestions.length > 0) {
      addNote(`[hint (good questions to ask for ${c.name})]: ${hintQuestions.join('; ')}`);
    }
  }

  if (notes.length === 0) return '';
  return `<business_knowledge>\n${notes.join('\n')}\n</business_knowledge>`;
}
