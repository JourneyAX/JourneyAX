import { PROVENANCE_KEY, type IngestConfig, type ProvenanceMap } from './types';

export interface ProvenanceViolation { entity: string; code: string; message: string }
export interface ProvenanceAudit { ok: boolean; violations: ProvenanceViolation[]; counts: Record<string, number> }

const DERIVED_KINDS = new Set(['catalogue_taxonomy', 'model_generated_keywords', 'crawl_document_candidate']);
const DERIVED_SOURCE_KINDS = new Set(['crawl', 'llm_draft', 'catalog_feed']);
const COMMERCE_RANK = {
  addToCart: { allowed: 0, allowed_with_warning: 1, blocked: 2 },
  checkout: { allowed: 0, requires_compatibility_resolution: 1, requires_professional_confirmation: 2, blocked: 3 },
} as const;

const marksOf = (entity: any): ProvenanceMap | undefined => entity?.extensions?.[PROVENANCE_KEY];

/**
 * Keeps derived material from posing as merchant-verified knowledge. Generated entities must declare where they came
 * from, must say they are unverified, must assert no claim class, must not be verified by a derived source, and must
 * not be more permissive in commerce than the merchant's configured ceiling.
 */
export function auditProvenance(draft: any, config?: Pick<IngestConfig, 'commerce'>): ProvenanceAudit {
  const violations: ProvenanceViolation[] = [];
  const counts: Record<string, number> = {};
  const sourceKind = new Map<string, string>((draft.sources || []).map((source: any) => [source.sourceId, source.kind]));
  const verifiedTargets = new Set<string>((draft.verifications || []).filter((record: any) => record.status === 'verified').map((record: any) => `${record.targetType}:${record.targetId}`));

  const check = (entityType: 'concept' | 'relationship', id: string, entity: any) => {
    const marks = marksOf(entity);
    if (!marks || !marks.structure) { violations.push({ entity: id, code: 'missing_provenance', message: 'Generated entity does not declare where it came from' }); return; }
    for (const [group, mark] of Object.entries(marks)) {
      counts[mark.kind] = (counts[mark.kind] || 0) + 1;
      if (!DERIVED_KINDS.has(mark.kind)) { violations.push({ entity: id, code: 'unknown_provenance_kind', message: `${group}: '${mark.kind}' is not a recognised derivation` }); continue; }
      if (mark.verified !== false) violations.push({ entity: id, code: 'derived_marked_verified', message: `${group}: derived material cannot be marked verified` });
    }
    if (entityType === 'relationship' && (entity.claimClasses || []).length > 0) {
      violations.push({ entity: id, code: 'derived_claim', message: 'A derived relationship cannot assert claim classes' });
    }
    if (verifiedTargets.has(`${entityType}:${id}`)) {
      violations.push({ entity: id, code: 'derived_verified_in_place', message: 'Verification of derived material must be recorded by re-authoring it, not by marking it verified in place' });
    }
    if (entityType === 'concept' && config) {
      const cart = COMMERCE_RANK.addToCart as Record<string, number>;
      const checkout = COMMERCE_RANK.checkout as Record<string, number>;
      if (cart[entity.commercePolicy.addToCart] < cart[config.commerce.addToCart] || checkout[entity.commercePolicy.checkout] < checkout[config.commerce.checkout]) {
        violations.push({ entity: id, code: 'derived_more_permissive', message: 'Derived concept is more permissive than the configured commerce ceiling' });
      }
    }
  };
  for (const concept of draft.concepts || []) check('concept', concept.conceptId, concept);
  for (const relationship of draft.relationships || []) check('relationship', relationship.relationshipId, relationship);

  for (const chunk of draft.evidenceChunks || []) {
    const kind = sourceKind.get(chunk.sourceRef);
    const governed = (chunk.claimClasses || []).filter((claim: string) => claim !== 'catalog_fact' && claim !== 'suggestion');
    if (kind && DERIVED_SOURCE_KINDS.has(kind) && governed.length > 0) {
      violations.push({ entity: chunk.chunkId, code: 'derived_evidence_as_claim', message: `A ${kind} source cannot back ${governed.join(', ')}` });
    }
  }
  return { ok: violations.length === 0, violations, counts };
}
