import type { JaxOntologyRelease } from '../model';
import type { KeyRepository, KeyRow, KeyScope } from '../keys';

/** A native ID needs no guessed cross-system link. Persisted conflicts always win; no metadata is written by a query. */
export function sourceIdentityKeys(repository: Pick<KeyRepository, 'findBySystemKey' | 'findByCanonicalId'>, block: JaxOntologyRelease, scope: { tenantId: string; environmentId: string; release: { version: string; checksum: string } }, now: () => Date) {
  const native = (keyScope: KeyScope, system: string, keyKind: string, value: string): KeyRow | undefined => {
    if (keyScope.tenantId !== scope.tenantId || keyScope.environmentId !== scope.environmentId) return;
    const thing = block.things.find(entry => entry.thing === keyScope.thing);
    if (!thing?.sourceIdentity || thing.sourceIdentity.system !== system || thing.sourceIdentity.keyKind !== keyKind || thing.key.canonical !== keyKind) return;
    const kind = thing.keyKinds.find(entry => entry.system === system && entry.kind === keyKind);
    if (!kind?.ready || kind.evidence !== 'real_field' || kind.caseRule !== 'as_is' || !value || value.length > 200 || value.includes('@') || !new RegExp(thing.key.pattern).test(value) || kind.pattern && !new RegExp(kind.pattern).test(value)) return;
    const at = now().toISOString();
    return { ...keyScope, canonicalId: value, system, keyKind, systemKey: value, status: 'matched', role: 'primary', evidence: 'real_field', firstSeenAt: at, lastVerifiedAt: at, builtBy: { runId: 'source-native-identity', releaseVersion: scope.release.version, releaseChecksum: scope.release.checksum } };
  };
  return {
    findBySystemKey: async (keyScope: KeyScope, system: string, keyKind: string, value: string) => {
      const stored = await repository.findBySystemKey(keyScope, system, keyKind, value);
      return stored ?? native(keyScope, system, keyKind, value);
    },
    findByCanonicalId: async (keyScope: KeyScope, value: string) => {
      const stored = await repository.findByCanonicalId(keyScope, value);
      const identity = block.things.find(entry => entry.thing === keyScope.thing)?.sourceIdentity;
      if (!identity || stored.some(row => row.system === identity.system && row.keyKind === identity.keyKind)) return stored;
      const row = native(keyScope, identity.system, identity.keyKind, value);
      return row ? [...stored, row] : stored;
    },
  };
}
