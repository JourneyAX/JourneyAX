import { createHash } from 'node:crypto';
import type { OkfReleaseContent } from './contracts';

/** Stable UTF-16 code-unit order; independent of host locale and ICU data. */
export function compareKnowledgeKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableKnowledgeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKnowledgeJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareKnowledgeKeys(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableKnowledgeJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeKnowledgeChecksum(content: OkfReleaseContent | unknown): string {
  return createHash('sha256').update(stableKnowledgeJson(content)).digest('hex');
}

export function computeKnowledgeEntityHash(entity: Record<string, unknown>): string {
  const { contentHash: _contentHash, verificationRef: _verificationRef, lifecycle: _lifecycle, ...claimContent } = entity;
  return createHash('sha256').update(stableKnowledgeJson(claimContent)).digest('hex');
}

/** Authoring helper. Verification/lifecycle metadata never changes the claim-bearing hash. */
export function withKnowledgeEntityHash<T extends Record<string, unknown>>(
  entity: Omit<T, 'contentHash'>
): T & { contentHash: string } {
  return { ...entity, contentHash: computeKnowledgeEntityHash(entity) } as T & { contentHash: string };
}
