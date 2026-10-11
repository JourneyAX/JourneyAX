import { computeKnowledgeEntityHash } from './checksum';

const HASHED_COLLECTIONS = ['concepts', 'relationships', 'evidenceChunks'] as const;

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
