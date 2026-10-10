import { createHash } from 'crypto';
import {
  ChecksumSchemaVersion,
  ChecksumSchemaVersionSchema,
  SUPPORTED_CHECKSUM_SCHEMA_VERSIONS,
  extractPackContent,
} from './schemas/business-pack.schema';

/**
 * Legacy canonical JSON serializer (v1 / legacy).
 * Omits undefined object properties, but strictly PRESERVES explicit null values.
 * Keys are sorted lexicographically; array order is preserved.
 */
export function stableJsonLegacy(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonLegacy).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonLegacy(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Modern canonical JSON serializer (v2).
 * Omits both undefined and null object properties for normalized payloads.
 * Keys are sorted lexicographically; array order is preserved.
 */
export function stableJsonV2(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonV2).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonV2(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical JSON serializer alias for backward compatibility.
 * Defaults to the legacy algorithm unless checksumSchemaVersion === 2.
 */
export function stableJson(value: unknown): string {
  return stableJsonLegacy(value);
}

/**
 * Validates a checksum schema version. Absent means the legacy algorithm (1).
 * Anything outside SUPPORTED_CHECKSUM_SCHEMA_VERSIONS (0, 3, 999, negatives, strings, null,
 * non-integers) is rejected: an unknown version must never be hashed with a guessed algorithm.
 */
export function parseChecksumSchemaVersion(value: unknown): ChecksumSchemaVersion {
  if (value === undefined) return 1;
  const parsed = ChecksumSchemaVersionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[BusinessPackChecksum] Unsupported checksumSchemaVersion ${JSON.stringify(value)} (supported: ${SUPPORTED_CHECKSUM_SCHEMA_VERSIONS.join(', ')}, or absent for legacy)`
    );
  }
  return parsed.data;
}

/**
 * Exhaustive algorithm selection: adding a member to ChecksumSchemaVersion without handling it
 * here is a compile error (the `never` check below).
 */
export function resolveChecksumAlgorithm(version: ChecksumSchemaVersion): (value: unknown) => string {
  switch (version) {
    case 1:
      return stableJsonLegacy;
    case 2:
      return stableJsonV2;
    default: {
      const unreachable: never = version;
      throw new Error(`[BusinessPackChecksum] Unhandled checksumSchemaVersion ${String(unreachable)}`);
    }
  }
}

/**
 * Computes the authoritative sha256 checksum for immutable Business Pack content.
 * Accepts either content or an envelope, automatically extracting only immutable content keys.
 * Preserves legacy checksums when checksumSchemaVersion is absent or 1.
 * Throws on any unsupported checksumSchemaVersion (fail closed).
 */
export function computePackChecksum(packOrEnvelope: unknown): string {
  const content = extractPackContent(packOrEnvelope);
  const version = parseChecksumSchemaVersion((content as Record<string, unknown>).checksumSchemaVersion);
  const serialize = resolveChecksumAlgorithm(version);
  return createHash('sha256').update(serialize(content)).digest('hex');
}
