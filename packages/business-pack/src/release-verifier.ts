import {
  BusinessPackContent,
  BusinessPackContentSchema,
  BusinessPackEnvelope,
  normalizeLegacyStoredContent,
  parsePersistedRelease,
} from './schemas/business-pack.schema';
import { validateBusinessPack } from './validator';
import { computePackChecksum } from './checksum';

/**
 * Authoritative persisted-release verifier.
 *
 * Every consumer that reads a Business Pack release document from storage and trusts its content
 * (loader, rollback, outbox worker, capability registry, back-office routes, ...) MUST go through
 * verifyPersistedBusinessPackRelease(). Parsing, legacy normalization, checksum recomputation and
 * identity checks live ONLY here; consumers never re-implement them.
 */

export type ReleaseVerificationFailureReason =
  | 'malformed_envelope'
  | 'withdrawn'
  | 'incomplete_content'
  | 'unsupported_checksum_version'
  | 'semantic_invalid'
  | 'missing_checksum'
  | 'checksum_mismatch'
  | 'pointer_checksum_mismatch'
  | 'identity_mismatch'
  | 'scope_mismatch';

export class ReleaseVerificationError extends Error {
  constructor(
    public readonly reason: ReleaseVerificationFailureReason,
    message: string,
    public readonly details?: unknown
  ) {
    super(`[ReleaseVerification:${reason}] ${message}`);
    this.name = 'ReleaseVerificationError';
  }
}

/** Caller-expected identity. Anything provided is enforced against BOTH the envelope and the content. */
export interface ExpectedReleaseScope {
  tenantId?: string;
  environmentId?: string;
  version?: string;
  /** Checksum of the active pointer (or other authority) the stored release must agree with. */
  pointerChecksum?: string;
}

export interface VerifiedBusinessPackRelease {
  envelope: BusinessPackEnvelope;
  /** Schema-parsed, legacy-normalized immutable content: exactly what was hashed at publication. */
  content: BusinessPackContent;
  checksum: string;
}

const WITHDRAWN_STATES = new Set(['withdrawn', 'revoked']);

function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `[${i.path.map(String).join('.') || '<root>'}] ${i.message}`).join('; ');
}

/**
 * Order (each step fail-closed with a typed reason):
 *  1. parse storage envelope               -> malformed_envelope / unsupported_checksum_version
 *  2. reject withdrawn / revoked releases  -> withdrawn
 *  3. extract immutable content
 *  4. documented read-only legacy normalization
 *  5. parse with BusinessPackContentSchema -> incomplete_content / unsupported_checksum_version
 *  6. semantic / reference validation      -> semantic_invalid
 *  7. require nonblank stored checksum     -> missing_checksum
 *  8. recompute versioned checksum, compare-> checksum_mismatch
 *  9. compare with pointer checksum        -> pointer_checksum_mismatch
 * 10. envelope identity equals content identity            -> identity_mismatch
 * 11. envelope + content identity equal caller expectation -> scope_mismatch
 */
export function verifyPersistedBusinessPackRelease(
  document: unknown,
  expected: ExpectedReleaseScope = {}
): VerifiedBusinessPackRelease {
  // 1. envelope
  const persisted = parsePersistedRelease(document);
  if (persisted.ok === false) {
    const unsupported = /checksumSchemaVersion/.test(persisted.error);
    throw new ReleaseVerificationError(
      unsupported ? 'unsupported_checksum_version' : 'malformed_envelope',
      persisted.error
    );
  }
  const { envelope } = persisted;

  // 2. withdrawn / revoked (operational state never alters content, but must stop its use)
  const operationalStatus = envelope.operationalState?.status;
  if (WITHDRAWN_STATES.has(String(envelope.status)) || WITHDRAWN_STATES.has(String(operationalStatus))) {
    throw new ReleaseVerificationError(
      'withdrawn',
      `Release '${envelope.version ?? envelope.versionId ?? '<unknown>'}' for tenant '${envelope.tenantId ?? '<unknown>'}' is ${
        envelope.status === 'withdrawn' || envelope.status === 'revoked' ? envelope.status : operationalStatus
      } and must not be used`
    );
  }

  // 3-4. Extract and normalize the immutable STORED content. The checksum must be
  // recomputed from this representation, not from today's schema-parsed output:
  // later schema versions may add defaults or strip legacy fields that were part
  // of the original publication hash.
  const normalizedStoredContent = normalizeLegacyStoredContent(persisted.content);

  // 5. Parse a separate execution view with the current schema. Consumers receive
  // this validated view, while integrity remains anchored to the immutable bytes
  // represented by normalizedStoredContent.
  const parsed = BusinessPackContentSchema.safeParse(normalizedStoredContent);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.some((i) => i.path[0] === 'checksumSchemaVersion');
    throw new ReleaseVerificationError(
      unsupported ? 'unsupported_checksum_version' : 'incomplete_content',
      `Release content failed schema validation: ${formatZodIssues(parsed.error)}`,
      parsed.error.format()
    );
  }
  const content = parsed.data;

  // 6. semantic / reference validation
  const validation = validateBusinessPack(content);
  if (!validation.valid) {
    const errors = validation.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `[${i.path}] ${i.message}`)
      .join('; ');
    throw new ReleaseVerificationError('semantic_invalid', `Release failed semantic validation: ${errors}`, validation.issues);
  }

  // 7. stored checksum
  const storedChecksum = typeof envelope.checksum === 'string' ? envelope.checksum.trim() : '';
  if (!storedChecksum) {
    throw new ReleaseVerificationError('missing_checksum', 'Release has a missing or blank stored checksum');
  }

  // 8. Recompute from normalized immutable STORED content. New publications persist
  // their schema-parsed content in full, so this is identical for current releases;
  // historical releases remain stable across later schema evolution.
  let computed: string;
  try {
    computed = computePackChecksum(normalizedStoredContent);
  } catch (err: any) {
    throw new ReleaseVerificationError('unsupported_checksum_version', err.message);
  }
  if (computed !== storedChecksum) {
    throw new ReleaseVerificationError(
      'checksum_mismatch',
      `Stored checksum '${storedChecksum}' does not match recomputed '${computed}'`
    );
  }

  // 9. pointer agreement
  if (expected.pointerChecksum !== undefined) {
    const pointerChecksum = typeof expected.pointerChecksum === 'string' ? expected.pointerChecksum.trim() : '';
    if (!pointerChecksum || pointerChecksum !== computed) {
      throw new ReleaseVerificationError(
        'pointer_checksum_mismatch',
        `Active pointer checksum '${pointerChecksum || '<blank>'}' does not match verified release checksum '${computed}'`
      );
    }
  }

  // 10. envelope identity must equal content identity
  const manifest = content.manifest;
  const identityChecks: Array<[string, unknown, string]> = [
    ['tenantId', envelope.tenantId, manifest.tenantId],
    ['environmentId', envelope.environmentId, manifest.environmentId],
    ['version', envelope.version, manifest.version],
  ];
  if (envelope.versionId !== undefined) {
    identityChecks.push(['versionId', envelope.versionId, manifest.version]);
  }
  for (const [field, envelopeValue, contentValue] of identityChecks) {
    if (envelopeValue === undefined) {
      throw new ReleaseVerificationError('identity_mismatch', `Release envelope is missing required identity field '${field}'`);
    }
    if (envelopeValue !== contentValue) {
      throw new ReleaseVerificationError(
        'identity_mismatch',
        `Envelope ${field} '${String(envelopeValue)}' does not match content manifest '${contentValue}'`
      );
    }
  }

  // 11. caller expectation
  const scopeChecks: Array<[string, string | undefined, string]> = [
    ['tenantId', expected.tenantId, manifest.tenantId],
    ['environmentId', expected.environmentId, manifest.environmentId],
    ['version', expected.version, manifest.version],
  ];
  for (const [field, expectedValue, actual] of scopeChecks) {
    if (expectedValue !== undefined && expectedValue !== actual) {
      throw new ReleaseVerificationError(
        'scope_mismatch',
        `Requested ${field} '${expectedValue}' does not match release ${field} '${actual}'`
      );
    }
  }

  return { envelope, content, checksum: computed };
}

/** Non-throwing variant for callers that map failures to their own contract (e.g. loader -> null). */
export function tryVerifyPersistedBusinessPackRelease(
  document: unknown,
  expected: ExpectedReleaseScope = {}
): { ok: true; release: VerifiedBusinessPackRelease } | { ok: false; error: ReleaseVerificationError } {
  try {
    return { ok: true, release: verifyPersistedBusinessPackRelease(document, expected) };
  } catch (err) {
    if (err instanceof ReleaseVerificationError) return { ok: false, error: err };
    throw err;
  }
}
