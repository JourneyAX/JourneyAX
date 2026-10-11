/**
 * Pure helpers for the OKF Studio. They only shape data the server already owns:
 * hashes are rebound by the server on save and readiness is computed by the server's analysis endpoint,
 * so nothing here decides what may be published.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface StalenessEntry {
  targetType: 'concept' | 'relationship';
  targetId: string;
  reason: 'edited_since_verification' | 'unverified' | 'expired';
}

export interface ReadinessCheck { id: string; ok: boolean; detail?: string }

/** Customer-facing copy lives with the UI, keyed by the server's check ids. */
export const CHECK_LABELS: Record<string, string> = {
  draft_present: 'A draft exists',
  draft_valid: 'The draft passes validation',
  verifications_current: 'Every claim has a current, human-verified record',
  release_published: 'An immutable release is published',
  artifact_exported: 'The release artifact is exported and verified',
};

export const STALENESS_LABELS: Record<StalenessEntry['reason'], string> = {
  edited_since_verification: 'Edited since it was verified',
  unverified: 'Not verified',
  expired: 'Verification expired',
};

export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function formatList(values: string[] | undefined): string {
  return (values || []).join(', ');
}

function verificationFor(content: any, targetType: 'concept' | 'relationship', targetId: string) {
  return (content?.verifications || []).find((record: any) => record.targetType === targetType && record.targetId === targetId);
}

const bareHash = (hash?: string) => (hash || '').replace(/^sha256:/, '');

export function relationshipBadge(content: any, relationship: any): { label: string; tone: Tone; detail: string } {
  const record = verificationFor(content, 'relationship', relationship.relationshipId);
  if (!record || record.status === 'unverified') {
    return { label: 'Unverified', tone: 'bad', detail: 'Cannot support compatibility, requirement, safety or substitution claims.' };
  }
  if (record.status === 'in_review') {
    return { label: 'In review', tone: 'warn', detail: 'Waiting for the assigned verifier.' };
  }
  if (bareHash(record.contentHash) !== bareHash(relationship.contentHash)) {
    return { label: 'Edited — re-verify', tone: 'warn', detail: 'Content changed after verification; the old verification no longer applies.' };
  }
  if (record.staleAfter && new Date(record.staleAfter) <= new Date()) {
    return { label: 'Verification expired', tone: 'warn', detail: `Expired ${record.staleAfter}.` };
  }
  return { label: 'Verified', tone: 'ok', detail: `Verified by ${record.verifiedBy} (${record.verifierRole}).` };
}

export function groupStaleness(entries: StalenessEntry[]): Array<{ reason: StalenessEntry['reason']; label: string; entries: StalenessEntry[] }> {
  const order: StalenessEntry['reason'][] = ['edited_since_verification', 'expired', 'unverified'];
  return order
    .map((reason) => ({ reason, label: STALENESS_LABELS[reason], entries: entries.filter((entry) => entry.reason === reason) }))
    .filter((group) => group.entries.length > 0);
}

export interface ConceptPatch {
  name?: string;
  description?: string;
  synonyms?: string[];
  customerPhrases?: string[];
  riskClass?: 'standard' | 'compatibility' | 'safety_critical';
  compatibilitySensitive?: boolean;
  addToCart?: 'allowed' | 'allowed_with_warning' | 'blocked';
  checkout?: 'allowed' | 'requires_compatibility_resolution' | 'requires_professional_confirmation' | 'blocked';
  blocksProducts?: boolean;
  lifecycleStatus?: 'active_draft' | 'deprecated' | 'retired';
  requiredFacts?: Array<{ factKey: string; importance: 'high' | 'medium' | 'low' }>;
  catalogCategoryIds?: string[];
}

/** Returns a copy of the draft with one concept edited. contentHash is deliberately left for the server to rebind. */
export function patchConcept(content: any, conceptId: string, patch: ConceptPatch): any {
  if (!(content?.concepts || []).some((concept: any) => concept.conceptId === conceptId)) {
    throw new Error(`Concept ${conceptId} is not in the draft`);
  }
  return {
    ...content,
    concepts: content.concepts.map((concept: any) => {
      if (concept.conceptId !== conceptId) return concept;
      const next = { ...concept };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.synonyms) next.synonyms = patch.synonyms;
      if (patch.customerPhrases) next.customerPhrases = patch.customerPhrases;
      if (patch.riskClass) next.riskClass = patch.riskClass;
      if (patch.compatibilitySensitive !== undefined) next.compatibilitySensitive = patch.compatibilitySensitive;
      if (patch.addToCart || patch.checkout) {
        next.commercePolicy = { ...concept.commercePolicy, ...(patch.addToCart ? { addToCart: patch.addToCart } : {}), ...(patch.checkout ? { checkout: patch.checkout } : {}) };
      }
      if (patch.blocksProducts !== undefined) next.safety = { ...concept.safety, blocksProducts: patch.blocksProducts };
      if (patch.lifecycleStatus) next.lifecycle = { ...concept.lifecycle, status: patch.lifecycleStatus };
      if (patch.requiredFacts) next.requiredFacts = patch.requiredFacts;
      if (patch.catalogCategoryIds) next.searchScope = { ...concept.searchScope, catalogCategoryIds: patch.catalogCategoryIds };
      return next;
    }),
  };
}

/**
 * Assigns a verifier to a target by writing a verification record bound to the target's current hash.
 * The record still needs the verifier's own server-side attestation before it can ship.
 */
export function assignVerifier(
  content: any,
  input: { targetType: 'concept' | 'relationship'; targetId: string; verifiedBy: string; verifierRole: string; now?: Date },
): any {
  const collection = input.targetType === 'concept' ? content.concepts : content.relationships;
  const idKey = input.targetType === 'concept' ? 'conceptId' : 'relationshipId';
  const target = (collection || []).find((entity: any) => entity[idKey] === input.targetId);
  if (!target) throw new Error(`${input.targetType} ${input.targetId} is not in the draft`);
  if (!input.verifiedBy.trim() || !input.verifierRole.trim()) throw new Error('A verifier and a verifier role are required');
  const existing = verificationFor(content, input.targetType, input.targetId);
  const record = {
    ...(existing || {}),
    recordId: existing?.recordId || `ver-${input.targetType}-${input.targetId}`.replace(/[^a-zA-Z0-9._:/-]+/g, '-'),
    targetType: input.targetType,
    targetId: input.targetId,
    status: 'verified',
    sourceRefs: existing?.sourceRefs || target.sourceRefs || target.evidenceRefs || [],
    verifiedBy: input.verifiedBy.trim(),
    verifierRole: input.verifierRole.trim(),
    verifiedAt: (input.now || new Date()).toISOString(),
    contentHash: target.contentHash,
  };
  return {
    ...content,
    verifications: existing
      ? content.verifications.map((candidate: any) => (candidate === existing ? record : candidate))
      : [...(content.verifications || []), record],
  };
}

export function revocationTone(status: 'active' | 'lifted' | 'expired'): Tone {
  return status === 'active' ? 'bad' : status === 'lifted' ? 'ok' : 'neutral';
}

export function splitRevocations<T extends { status: string }>(items: T[]): { active: T[]; history: T[] } {
  return { active: items.filter((item) => item.status === 'active'), history: items.filter((item) => item.status !== 'active') };
}

export const ENVIRONMENTS = ['dev', 'test', 'staging', 'production'] as const;
export type EnvironmentId = typeof ENVIRONMENTS[number];
