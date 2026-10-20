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
}

export const OKF_ALLOWED_RELATIONSHIP_TYPES = new Set([
  'requires',
  'installed_with',
  'cross_sell',
  'compatible_with',
  'incompatible_with',
  'alternative_to',
  'care_for',
  'document_for',
  'escalates_to',
]);

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
  }

  // 2. Relationships (keep only requires, installed_with, cross_sell, compatible_with, incompatible_with, alternative_to, care_for, document_for, escalates_to; exclude child_of)
  const conceptMap = new Map<string, OkfConcept>(concepts.map((c) => [c.conceptId, c]));
  const activeIds = new Set<string>(activeConcepts.map((c) => c.conceptId));

  const relevantRels = relationships.filter(
    (r) => (activeIds.has(r.from) || activeIds.has(r.to)) && OKF_ALLOWED_RELATIONSHIP_TYPES.has(r.type)
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

  if (notes.length === 0) return '';
  return `<business_knowledge>\n${notes.join('\n')}\n</business_knowledge>`;
}
