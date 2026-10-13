import { computeKnowledgeEntityHash } from './checksum';

const HASHED_COLLECTIONS = ['concepts', 'relationships', 'evidenceChunks'] as const;

/**
 * Content is stored as plain data. A field holding `undefined` is the same as an absent field to every hash in this package, but the
 * database driver stores it as `null`, which hashes differently: a draft that carried one would validate in memory and then fail
 * integrity checks after a round trip through storage. Dropping them first makes what is hashed identical to what is stored.
 */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : dropUndefined(entry))) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, dropUndefined(entry)])) as T;
  }
  return value;
}

/**
 * Draft hashes are server-owned. An editor (form, JSON, import) changes claim-bearing content and the
 * server rebinds each entity's contentHash to it. Verification records are NOT touched: an edited entity
 * no longer matches the hash its verification covers, so it surfaces as stale and needs re-attestation.
 */
export function bindDraftEntityHashes<T>(content: T): T {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const next: Record<string, unknown> = { ...(content as Record<string, unknown>) };
  for (const key of HASHED_COLLECTIONS) {
    const list = next[key];
    if (!Array.isArray(list)) continue;
    next[key] = list.map((entity) => entity && typeof entity === 'object' && !Array.isArray(entity)
      ? { ...entity, contentHash: computeKnowledgeEntityHash(entity as Record<string, unknown>) }
      : entity);
  }
  return next as T;
}

export interface DraftStalenessEntry {
  targetType: 'concept' | 'relationship';
  targetId: string;
  reason: 'edited_since_verification' | 'unverified' | 'expired';
}

/** Which verified claims need attention: edited after verification, never verified, or past `staleAfter`. */
export function findStaleVerifications(content: any, now = new Date()): DraftStalenessEntry[] {
  const entries: DraftStalenessEntry[] = [];
  const verifications: any[] = Array.isArray(content?.verifications) ? content.verifications : [];
  const byTarget = new Map(verifications.map((record) => [`${record.targetType}:${record.targetId}`, record]));
  const consider = (targetType: 'concept' | 'relationship', targetId: string, hash: string | undefined) => {
    const record = byTarget.get(`${targetType}:${targetId}`);
    if (!record || record.status !== 'verified') {
      entries.push({ targetType, targetId, reason: 'unverified' });
    } else if ((record.contentHash || '').replace(/^sha256:/, '') !== (hash || '').replace(/^sha256:/, '')) {
      entries.push({ targetType, targetId, reason: 'edited_since_verification' });
    } else if (record.staleAfter && new Date(record.staleAfter) <= now) {
      entries.push({ targetType, targetId, reason: 'expired' });
    }
  };
  for (const concept of content?.concepts || []) consider('concept', concept.conceptId, concept.contentHash);
  for (const relationship of content?.relationships || []) consider('relationship', relationship.relationshipId, relationship.contentHash);
  return entries;
}

/** What a person's check would be about, in plain terms. */
export type VerificationTopic = 'safety' | 'compatibility' | 'care' | 'documents';

export interface VerificationWorkEntry extends DraftStalenessEntry {
  about: VerificationTopic;
}

/** The plain topic a claim class belongs to; a closed platform list, so every claim class is placed. */
const TOPIC_OF_CLAIM: Record<string, VerificationTopic> = {
  safety_instruction: 'safety',
  care_safety: 'care',
  compatibility: 'compatibility',
  requirement: 'compatibility',
  substitution: 'compatibility',
  installation_step: 'documents',
  legal_requirement: 'documents',
  warranty: 'documents',
  catalog_fact: 'documents',
  suggestion: 'documents',
};

/**
 * The part of the verification list a person can actually act on. {@link findStaleVerifications} lists every concept and every
 * relationship without a current verification, which for a catalogue-shaped release is almost all of it: a category's place in the tree
 * ("Wood Screws is inside Fastenings") and a "Have you considered?" suggestion make no claim, so there is nothing for anyone to verify.
 * A check matters when it could change what the assistant may say:
 *
 *   - a relationship that carries a claim class (for example a care instruction),
 *   - a topic about a problem or about care, or one marked safety-critical or compatibility-sensitive,
 *   - a topic that has candidate manufacturer documents waiting to be reviewed,
 *   - anything already verified that has since been edited or has expired.
 */
export function findVerificationWork(content: any, now = new Date()): VerificationWorkEntry[] {
  const concepts = new Map<string, any>((content?.concepts || []).map((concept: any) => [concept.conceptId, concept]));
  const relationships = new Map<string, any>((content?.relationships || []).map((relationship: any) => [relationship.relationshipId, relationship]));
  const candidateSources = new Set<string>((content?.sources || []).filter((source: any) => source?.kind === 'crawl').map((source: any) => source.sourceId));

  const topicOfConcept = (concept: any): VerificationTopic | undefined => {
    if (!concept) return undefined;
    if (concept.lens === 'problem' || concept.riskClass === 'safety_critical') return 'safety';
    if (concept.lens === 'care') return 'care';
    if (concept.riskClass === 'compatibility' || concept.compatibilitySensitive === true) return 'compatibility';
    if ((concept.evidenceRefs || []).some((id: string) => candidateSources.has(id))) return 'documents';
    return undefined;
  };
  const topicOfRelationship = (relationship: any): VerificationTopic | undefined => {
    const classes: string[] = relationship?.claimClasses || [];
    if (classes.length === 0) return undefined;
    const topics = classes.map((claimClass) => TOPIC_OF_CLAIM[claimClass] ?? 'documents');
    return (['safety', 'compatibility', 'care', 'documents'] as const).find((topic) => topics.includes(topic));
  };

  const work: VerificationWorkEntry[] = [];
  for (const entry of findStaleVerifications(content, now)) {
    const topic = entry.targetType === 'concept' ? topicOfConcept(concepts.get(entry.targetId)) : topicOfRelationship(relationships.get(entry.targetId));
    // Something already verified that went stale matters whatever it is; something never verified matters only if it can carry a claim.
    if (entry.reason === 'unverified' && !topic) continue;
    work.push({ ...entry, about: topic ?? 'documents' });
  }
  return work;
}
