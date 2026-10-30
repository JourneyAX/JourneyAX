import type { ConnectorsExtension, ReleaseVerificationFailureReason } from '@journeyax/business-pack';
import type { JaxOntologyRelease } from '../model';
import type { JaxIqErrorCode } from '../errors/codes';

/** One verified release of a tenant: the dictionary and the connector table it is checked against. */
export interface LoadedRelease {
  version: string;
  checksum: string;
  ontology: JaxOntologyRelease;
  connectors: ConnectorsExtension;
}

/**
 * Why a release could not be used. The first ten are the reasons the release verifier gives. `ontology_disabled`: the release has no
 * dictionary block, or the block says `enabled: false`. `ontology_invalid`: the block does not pass the schema or the release checks.
 * `no_active_release`: the tenant has no published release.
 */
export type ReleaseFailureReason = ReleaseVerificationFailureReason | 'ontology_disabled' | 'ontology_invalid' | 'no_active_release';

/** The answer when no release can be used. `release_mismatch` is for a pinned release the service holds a different copy of. */
export interface ReleaseFailure {
  ok: false;
  code: Extract<JaxIqErrorCode, 'release_unavailable' | 'release_mismatch'>;
  reason: ReleaseFailureReason;
  message: string;
}

/**
 * Where the service gets a release. With a pin it returns exactly that release and fails closed on a checksum mismatch; without one it
 * returns the published release. A load never forces a re-read.
 */
export interface ReleaseSource {
  load(tenantId: string, environmentId: string, pin?: { version: string; checksum: string }): Promise<LoadedRelease | ReleaseFailure>;
}

export function isReleaseFailure(result: LoadedRelease | ReleaseFailure): result is ReleaseFailure {
  return 'ok' in result && result.ok === false;
}
