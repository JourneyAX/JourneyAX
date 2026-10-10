import {
  OkfReleaseContentSchema,
  type OkfReleaseContent,
  type OkfVerificationRecord,
} from './contracts';
import { computeKnowledgeEntityHash } from './checksum';

export interface OkfValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface OkfValidationResult {
  valid: boolean;
  issues: OkfValidationIssue[];
  content?: OkfReleaseContent;
}

export interface OkfJourneyReferenceTarget {
  journeyId: string;
  stages?: Record<string, unknown>;
}

/** Validates the explicit OKF-to-Business-Pack routing boundary. */
export function validateOkfJourneyReferences(
  content: OkfReleaseContent,
  journeys: OkfJourneyReferenceTarget[]
): OkfValidationIssue[] {
  const byId = new Map(journeys.map((journey) => [journey.journeyId, journey]));
  const issues: OkfValidationIssue[] = [];
  for (const concept of content.concepts) {
    const ref = concept.journeyRef;
    if (!ref) continue;
    const journey = byId.get(ref.journeyId);
    if (!journey) {
      issues.push({
        code: 'unresolved_journey_ref',
        path: `${concept.conceptId}.journeyRef.journeyId`,
        message: `Journey '${ref.journeyId}' does not exist in the Business Pack`,
      });
      continue;
    }
    if (ref.entryStageId && !journey.stages?.[ref.entryStageId]) {
      issues.push({
        code: 'unresolved_entry_stage_ref',
        path: `${concept.conceptId}.journeyRef.entryStageId`,
        message: `Stage '${ref.entryStageId}' does not exist in journey '${ref.journeyId}'`,
      });
    }
  }
  return issues;
}

function tenantFromConceptId(conceptId: string): string | undefined {
  return /^concept:\/\/([^/]+)\//.exec(conceptId)?.[1];
}

function conditionDepth(value: any): number {
  if (!value || typeof value !== 'object' || 'fact' in value) return 1;
  if ('not' in value) return 1 + conditionDepth(value.not);
  const children = value.all || value.any || [];
  return 1 + Math.max(0, ...children.map(conditionDepth));
}

function verificationIsQualified(
  verification: OkfVerificationRecord | undefined,
  sourceKinds: Set<string>,
  claimClasses: string[]
): boolean {
  if (!verification || verification.status !== 'verified') return true;
  const role = (verification.verifierRole || '').toLowerCase();
  if (claimClasses.includes('legal_requirement')) {
    return sourceKinds.has('regulation') && /compliance|legal|regulat/.test(role);
  }
  if (claimClasses.some((c) => ['safety_instruction', 'care_safety', 'installation_step'].includes(c))) {
    return /trade|plumb|electric|builder|product|safety|compliance/.test(role);
  }
  return true;
}

export function validateOkfReleaseContent(input: unknown, tenantId: string): OkfValidationResult {
  const parsed = OkfReleaseContentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'schema_invalid',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const content = parsed.data;
  const issues: OkfValidationIssue[] = [];
  const concepts = new Map(content.concepts.map((concept) => [concept.conceptId, concept]));
  const relationships = new Map(content.relationships.map((relationship) => [relationship.relationshipId, relationship]));
  const sources = new Map(content.sources.map((source) => [source.sourceId, source]));
  const verifications = new Map(content.verifications.map((record) => [record.recordId, record]));
  const facts = new Set(content.factRegistry.map((fact) => fact.factKey));

  const assertUnique = (values: string[], path: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) issues.push({ code: 'duplicate_id', path, message: `Duplicate id '${value}'` });
      seen.add(value);
    }
  };
  assertUnique(content.concepts.map((c) => c.conceptId), 'concepts');
  assertUnique(content.relationships.map((r) => r.relationshipId), 'relationships');
  assertUnique(content.sources.map((s) => s.sourceId), 'sources');
  assertUnique(content.evidenceChunks.map((chunk) => chunk.chunkId), 'evidenceChunks');
  assertUnique(content.verifications.map((v) => v.recordId), 'verifications');
  assertUnique(content.factRegistry.map((f) => f.factKey), 'factRegistry');

  for (const concept of content.concepts) {
    if (concept.tenantId !== tenantId || tenantFromConceptId(concept.conceptId) !== tenantId) {
      issues.push({ code: 'tenant_scope_mismatch', path: concept.conceptId, message: 'Concept tenant scope does not match release tenant' });
    }
    for (const required of concept.requiredFacts) {
      if (!facts.has(required.factKey)) issues.push({ code: 'unknown_fact', path: concept.conceptId, message: `Unknown fact '${required.factKey}'` });
    }
    for (const discriminator of concept.discriminators) {
      if (!facts.has(discriminator.factKey)) issues.push({ code: 'unknown_fact', path: concept.conceptId, message: `Unknown discriminator fact '${discriminator.factKey}'` });
      for (const target of Object.values(discriminator.valueMap)) {
        if (!concepts.has(target)) issues.push({ code: 'unresolved_concept', path: concept.conceptId, message: `Discriminator target '${target}' does not resolve` });
      }
    }
    for (const target of [...concept.safety.stepRefs, ...(concept.broadQueryPolicy?.groupConceptIds || [])]) {
      if (!concepts.has(target)) issues.push({ code: 'unresolved_concept', path: concept.conceptId, message: `Concept target '${target}' does not resolve` });
    }
    for (const sourceRef of concept.evidenceRefs) {
      if (!sources.has(sourceRef)) issues.push({ code: 'unresolved_source', path: concept.conceptId, message: `Evidence source '${sourceRef}' does not resolve` });
    }
    const expectedHash = computeKnowledgeEntityHash(concept as unknown as Record<string, unknown>);
    if (expectedHash !== concept.contentHash.replace(/^sha256:/, '')) {
      issues.push({ code: 'content_hash_mismatch', path: concept.conceptId, message: 'Concept contentHash does not bind to its current content' });
    }
    if (concept.verificationRef) {
      const verification = verifications.get(concept.verificationRef);
      if (!verification || verification.targetType !== 'concept' || verification.targetId !== concept.conceptId) {
        issues.push({ code: 'invalid_verification_ref', path: concept.conceptId, message: 'Concept verification reference does not resolve to this concept' });
      } else if (verification.contentHash.replace(/^sha256:/, '') !== concept.contentHash.replace(/^sha256:/, '')) {
        issues.push({ code: 'verification_hash_mismatch', path: concept.conceptId, message: 'Concept verification does not cover current contentHash' });
      }
    }
  }

  for (const relationship of content.relationships) {
    if (!concepts.has(relationship.from) || !concepts.has(relationship.to)) {
      issues.push({ code: 'unresolved_relationship', path: relationship.relationshipId, message: 'Relationship endpoints must resolve in the same release' });
    }
    if (tenantFromConceptId(relationship.from) !== tenantId || tenantFromConceptId(relationship.to) !== tenantId) {
      issues.push({ code: 'cross_tenant_relationship', path: relationship.relationshipId, message: 'Relationship endpoints must remain tenant scoped' });
    }
    if (relationship.conditions && conditionDepth(relationship.conditions) > 4) {
      issues.push({ code: 'condition_too_deep', path: relationship.relationshipId, message: 'Relationship condition depth exceeds 4' });
    }
    for (const sourceRef of relationship.sourceRefs) {
      if (!sources.has(sourceRef)) issues.push({ code: 'unresolved_source', path: relationship.relationshipId, message: `Source '${sourceRef}' does not resolve` });
    }
    const expectedHash = computeKnowledgeEntityHash(relationship as unknown as Record<string, unknown>);
    if (expectedHash !== relationship.contentHash.replace(/^sha256:/, '')) {
      issues.push({ code: 'content_hash_mismatch', path: relationship.relationshipId, message: 'Relationship contentHash does not bind to its current content' });
    }
    const verification = relationship.verificationRef ? verifications.get(relationship.verificationRef) : undefined;
    if (relationship.verificationRef && (!verification || verification.targetType !== 'relationship' || verification.targetId !== relationship.relationshipId)) {
      issues.push({ code: 'invalid_verification_ref', path: relationship.relationshipId, message: 'Relationship verification reference does not resolve to this relationship' });
    }
    if (verification && verification.contentHash.replace(/^sha256:/, '') !== relationship.contentHash.replace(/^sha256:/, '')) {
      issues.push({ code: 'verification_hash_mismatch', path: relationship.relationshipId, message: 'Relationship verification does not cover current contentHash' });
    }
    const sourceKinds = new Set(relationship.sourceRefs.map((id) => sources.get(id)?.kind).filter(Boolean) as string[]);
    if (!verificationIsQualified(verification, sourceKinds, relationship.claimClasses)) {
      issues.push({ code: 'unqualified_verification', path: relationship.relationshipId, message: 'Verifier role or source type is insufficient for the claim class' });
    }
    if (verification?.status === 'verified' && relationship.sourceRefs.some((id) => ['crawl', 'llm_draft', 'catalog_feed'].includes(sources.get(id)?.kind || '')) && !relationship.sourceRefs.some((id) => ['manufacturer_document', 'merchant_policy', 'regulation', 'trade_expert'].includes(sources.get(id)?.kind || ''))) {
      issues.push({ code: 'weak_source_verification', path: relationship.relationshipId, message: 'Weak sources alone cannot support a verified relationship' });
    }
  }

  for (const chunk of content.evidenceChunks) {
    if (!sources.has(chunk.sourceRef)) {
      issues.push({ code: 'unresolved_source', path: chunk.chunkId, message: `Evidence chunk source '${chunk.sourceRef}' does not resolve` });
    }
    for (const conceptId of chunk.conceptIds) {
      if (!concepts.has(conceptId)) {
        issues.push({ code: 'unresolved_concept', path: chunk.chunkId, message: `Evidence chunk concept '${conceptId}' does not resolve` });
      }
      if (tenantFromConceptId(conceptId) !== tenantId) {
        issues.push({ code: 'tenant_scope_mismatch', path: chunk.chunkId, message: 'Evidence chunk concepts must remain tenant scoped' });
      }
    }
    const expectedHash = computeKnowledgeEntityHash(chunk as unknown as Record<string, unknown>);
    if (expectedHash !== chunk.contentHash.replace(/^sha256:/, '')) {
      issues.push({ code: 'content_hash_mismatch', path: chunk.chunkId, message: 'Evidence chunk contentHash does not bind to its current content' });
    }
  }

  // Hierarchy is represented only by child_of, and must be acyclic.
  const parentByChild = new Map<string, string[]>();
  for (const relationship of content.relationships.filter((r) => r.type === 'child_of')) {
    parentByChild.set(relationship.from, [...(parentByChild.get(relationship.from) || []), relationship.to]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = (parentByChild.get(id) || []).some(walk);
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  if ([...concepts.keys()].some(walk)) {
    issues.push({ code: 'hierarchy_cycle', path: 'relationships', message: 'child_of hierarchy must be acyclic' });
  }

  for (const verification of content.verifications) {
    for (const sourceRef of verification.sourceRefs) {
      if (!sources.has(sourceRef)) issues.push({ code: 'unresolved_source', path: verification.recordId, message: `Verification source '${sourceRef}' does not resolve` });
    }
  }

  if (!content.evaluation.passed || content.evaluation.failedScenarioCount > 0) {
    issues.push({ code: 'evaluation_failed', path: 'evaluation', message: 'OKF release evaluation must pass before publication' });
  }

  return { valid: issues.length === 0, issues, content };
}
