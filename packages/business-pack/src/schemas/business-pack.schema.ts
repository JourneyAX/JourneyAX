import { z } from 'zod';
import { ManifestSchema } from './manifest.schema';
import { BusinessProfileSchema } from './business-profile.schema';
import { VocabularySchema } from './vocabulary.schema';
import { EntitiesSchema } from './entities.schema';
import { ModelPolicySchema } from './model-policy.schema';
import { AgentDefinitionSchema } from './agent.schema';
import { JourneyDefinitionSchema } from './journey.schema';
import { RuleDefinitionSchema } from './rule.schema';
import { CapabilityBindingsCollectionSchema } from './capability-binding.schema';
import { ExperienceSchema } from './experience.schema';
import { EvaluationSuiteSchema } from './evaluation.schema';
import { SpacePlannerExtensionSchema } from './space-planner.schema';
import { CatalogMappingSchema } from '../catalog-mapping';

export const RoutingPolicySchema = z.object({
  defaultJourneyId: z.string().nullish(),
  fallbackOnCatalogSearch: z.boolean().nullish(),
});

export const FactSensitivitySchema = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
  'pii',
]);

export const FactSourceSchema = z.enum([
  'customer',
  'capability',
  'inferred',
  'system',
  'knowledge',
  'integration',
]);

export const FactDefinitionSchema = z.object({
  key: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'date', 'enum']).optional(),
  allowedValues: z.array(z.string()).optional(),
  constraints: z.record(z.string(), z.any()).optional(),
  uiInputType: z.enum([
    'text',
    'select',
    'multi_select',
    'number',
    'slider',
    'date',
    'boolean_toggle',
    'card_choice',
  ]).optional(),
  unit: z.string().optional(),
  sensitivity: FactSensitivitySchema.optional(),
  permittedSources: z.array(FactSourceSchema).optional(),
  promptQuestion: z.string().optional(),
  entityRef: z.string().optional(),
  dimensionRef: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const FactRegistrySchema = z.object({
  version: z.string().optional(),
  facts: z.record(z.string(), FactDefinitionSchema).optional(),
});

export const OkfKnowledgeModelRefSchema = z.object({
  type: z.literal('okf_release'),
  modelId: z.string().min(1),
  releaseId: z.string().min(1),
  version: z.string().min(1),
  checksum: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i),
  required: z.boolean(),
  failurePolicy: z.enum(['fail_closed', 'enrichment_only']),
  registryUri: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).strict().superRefine((ref, ctx) => {
  if (ref.required && ref.failurePolicy !== 'fail_closed') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failurePolicy'],
      message: 'required OKF knowledge must use fail_closed',
    });
  }
});

export const InlineKnowledgeModelRefSchema = z.object({
  type: z.literal('inline'),
  modelId: z.string(),
  version: z.string().optional(),
  checksum: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).strict();

export const LegacyKnowledgeModelRefSchema = z.object({
  type: z.literal('legacy_search'),
  modelId: z.string().optional(),
  version: z.string().optional(),
  checksum: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).strict();

export const KnowledgeModelRefSchema = z.discriminatedUnion('type', [
  OkfKnowledgeModelRefSchema,
  InlineKnowledgeModelRefSchema,
  LegacyKnowledgeModelRefSchema,
]);

/**
 * Operational Release State & Lifecycle
 *
 * Operational rules:
 * 1. Active pointer selects a release for new workspaces.
 * 2. A future workspace pin keeps existing workspaces on their original pack and OKF releases.
 * 3. A withdrawn release overrides a workspace pin and must fail closed.
 * 4. Withdrawal is an operational mutation recorded in the envelope or append-only event log;
 *    it must NEVER mutate the immutable content or alter the content checksum.
 */
export const OperationalStateSchema = z.object({
  status: z.enum(['active', 'published', 'withdrawn', 'revoked', 'deprecated']).optional(),
  withdrawnAt: z.union([z.string(), z.date()]).optional(),
  withdrawnBy: z.string().optional(),
  withdrawalReason: z.string().optional(),
  supersededByVersion: z.string().optional(),
  auditTrail: z.array(z.record(z.string(), z.any())).optional(),
});

export const CANONICAL_CONTENT_KEYS = [
  'manifest',
  'profile',
  'routingPolicy',
  'vocabulary',
  'entities',
  'conversationPolicy',
  'modelPolicy',
  'agents',
  'journeys',
  'rules',
  'capabilities',
  'experience',
  'evaluations',
  'extensions',
  'factRegistry',
  'knowledgeModel',
  'catalogMapping',
  'checksumSchemaVersion',
] as const;

export type CanonicalContentKey = typeof CANONICAL_CONTENT_KEYS[number];

/**
 * Checksum schema versions this build understands.
 *  - absent / 1: legacy canonical JSON (explicit nulls are preserved).
 *  - 2: modern canonical JSON (null and undefined properties are omitted).
 * Anything else MUST fail closed; never fall back to a guessed algorithm.
 */
export const SUPPORTED_CHECKSUM_SCHEMA_VERSIONS = [1, 2] as const;
export type ChecksumSchemaVersion = typeof SUPPORTED_CHECKSUM_SCHEMA_VERSIONS[number];

export const ChecksumSchemaVersionSchema = z.union([z.literal(1), z.literal(2)]);

export const ConversationPolicySchema = z.object({
  fencingRules: z.array(z.string()).default([]),
  prohibitedTopics: z.array(z.string()).default([]),
  maxClarificationQuestionsPerTurn: z.number().int().min(1).max(10).default(3).optional(),
  allowJourneySwitch: z.boolean().default(true).optional(),
  defaultJourneyId: z.string().optional(),
  escalationThresholds: z.object({
    sentimentFloor: z.number().min(-1).max(1).default(-0.6),
    maxTurnsWithoutProgress: z.number().int().default(4),
  }).default({
    sentimentFloor: -0.6,
    maxTurnsWithoutProgress: 4,
  }),
});

/**
 * BusinessPackContentSchema
 *
 * Canonical schema for immutable, checksum-bearing Business Pack content.
 * Never includes operational state, database identity, or envelope metadata.
 *
 * Established top-level fields are REQUIRED and carry NO top-level defaults, so parsing
 * can never silently mutate checksum-bearing content. Only `factRegistry`, `knowledgeModel`
 * (and the pre-existing `routingPolicy` / `checksumSchemaVersion` markers) are optional.
 * Nested sub-schema defaults are retained: publishers have always hashed Zod-parsed output,
 * so they are part of the legacy checksum contract.
 */
export const BusinessPackContentSchema = z.object({
  manifest: ManifestSchema,
  profile: BusinessProfileSchema,
  routingPolicy: RoutingPolicySchema.nullish(),
  vocabulary: VocabularySchema,
  entities: EntitiesSchema,
  conversationPolicy: ConversationPolicySchema,
  modelPolicy: ModelPolicySchema,
  agents: z.array(AgentDefinitionSchema).min(1),
  journeys: z.array(JourneyDefinitionSchema).min(1),
  rules: z.array(RuleDefinitionSchema),
  capabilities: CapabilityBindingsCollectionSchema,
  experience: ExperienceSchema,
  evaluations: z.array(EvaluationSuiteSchema),
  extensions: z
    .object({
      spacePlanner: SpacePlannerExtensionSchema.optional(),
    })
    .catchall(z.any()),
  factRegistry: FactRegistrySchema.optional(),
  knowledgeModel: KnowledgeModelRefSchema.optional(),
  catalogMapping: CatalogMappingSchema.optional(),
  checksumSchemaVersion: ChecksumSchemaVersionSchema.optional(),
});

export type BusinessPackContent = z.infer<typeof BusinessPackContentSchema>;

/**
 * BusinessPackEnvelopeSchema
 *
 * Storage container for a persisted Business Pack release (MongoDB `business_pack_releases`).
 * Envelope metadata (identity, status, checksum, publication audit, operational state) lives
 * OUTSIDE the checksum. Content slots are only structurally typed here (object / array) and are
 * deliberately NOT parsed with their sub-schemas, so envelope validation can never inject Zod
 * defaults into checksum-bearing content. Full content validation is the job of
 * BusinessPackContentSchema after extractPackContent().
 *
 * Two persisted representations are supported (and nothing else):
 *  1. Flattened  - content keys sit beside the metadata (what publishBusinessPack writes).
 *  2. Nested     - content sits under `packData` (legacy readers in outbox / back-office).
 * A document carrying BOTH `packData` and flattened content keys is ambiguous and rejected.
 */
const StorageTimestampSchema = z.union([z.string(), z.date()]);
const PlainObjectSlot = z.record(z.string(), z.unknown());
const ArraySlot = z.array(z.unknown());

export const BusinessPackEnvelopeSchema = z
  .object({
    _id: z.unknown().optional(),
    tenantId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    versionId: z.string().min(1).optional(),
    status: z.string().optional(),
    checksum: z.string().optional(),
    publishedAt: StorageTimestampSchema.optional(),
    publishedBy: z.string().optional(),
    promotedAt: StorageTimestampSchema.optional(),
    promotedBy: z.string().optional(),
    revision: z.number().optional(),
    notes: z.string().optional(),
    operationalState: OperationalStateSchema.optional(),
    evaluationResult: z.unknown().optional(),
    // Nested representation
    packData: PlainObjectSlot.optional(),
    // Flattened content slots (structural type only; no sub-schema parsing, no defaults)
    manifest: PlainObjectSlot.optional(),
    profile: PlainObjectSlot.optional(),
    routingPolicy: PlainObjectSlot.nullish(),
    vocabulary: PlainObjectSlot.optional(),
    entities: PlainObjectSlot.optional(),
    conversationPolicy: PlainObjectSlot.optional(),
    modelPolicy: PlainObjectSlot.optional(),
    agents: ArraySlot.optional(),
    journeys: ArraySlot.optional(),
    rules: ArraySlot.optional(),
    capabilities: PlainObjectSlot.optional(),
    experience: PlainObjectSlot.optional(),
    evaluations: ArraySlot.optional(),
    extensions: PlainObjectSlot.optional(),
    factRegistry: PlainObjectSlot.optional(),
    knowledgeModel: PlainObjectSlot.optional(),
    catalogMapping: PlainObjectSlot.optional(),
    checksumSchemaVersion: ChecksumSchemaVersionSchema.optional(),
  })
  .passthrough()
  .superRefine((doc, ctx) => {
    if (doc.packData === undefined) return;
    const record = doc as Record<string, unknown>;
    for (const key of CANONICAL_CONTENT_KEYS) {
      if (record[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Ambiguous release envelope: content key '${key}' is present both flattened and inside 'packData'`,
        });
      }
    }
    const nested = doc.packData as Record<string, unknown>;
    const nestedVersion = nested.checksumSchemaVersion;
    if (nestedVersion !== undefined && !ChecksumSchemaVersionSchema.safeParse(nestedVersion).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['packData', 'checksumSchemaVersion'],
        message: `Unsupported checksumSchemaVersion in packData (supported: ${SUPPORTED_CHECKSUM_SCHEMA_VERSIONS.join(', ')})`,
      });
    }
  });

export type BusinessPackEnvelope = z.infer<typeof BusinessPackEnvelopeSchema>;

/**
 * Single canonical extractor for immutable Business Pack content.
 *
 * Guarantees:
 * - Extracts only immutable, checksum-bearing content keys (never envelope metadata).
 * - Unwraps the nested `packData` representation when present, otherwise reads the flat record.
 * - Preserves present fields as-is: no defaults are injected.
 *
 * This function is tolerant by design (it is also applied to already-parsed content).
 * Readers of PERSISTED documents must go through parsePersistedRelease() so the envelope
 * is validated first.
 */
export function extractPackContent(releaseOrEnvelope: unknown): BusinessPackContent {
  if (!releaseOrEnvelope || typeof releaseOrEnvelope !== 'object' || Array.isArray(releaseOrEnvelope)) {
    return {} as BusinessPackContent;
  }
  const record = releaseOrEnvelope as Record<string, unknown>;
  const nested = record.packData;
  const source =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;

  const content: Record<string, unknown> = {};
  for (const key of CANONICAL_CONTENT_KEYS) {
    if (source[key] !== undefined) {
      content[key] = source[key];
    }
  }
  return content as BusinessPackContent;
}

export type ParsePersistedReleaseResult =
  | { ok: true; envelope: BusinessPackEnvelope; content: BusinessPackContent }
  | { ok: false; error: string };

/**
 * Storage-envelope boundary: validates a persisted release document with
 * BusinessPackEnvelopeSchema, then extracts the immutable content. Envelope metadata is never
 * part of the returned content (and therefore never part of the checksum).
 * Malformed envelopes (non-objects, arrays, wrongly typed metadata, ambiguous flat+nested
 * documents, unsupported checksum schema versions) are rejected.
 */
export function parsePersistedRelease(doc: unknown): ParsePersistedReleaseResult {
  const parsed = BusinessPackEnvelopeSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Malformed Business Pack release envelope: ${parsed.error.issues
        .map((i) => `[${i.path.join('.') || '<root>'}] ${i.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, envelope: parsed.data, content: extractPackContent(parsed.data) };
}

/**
 * Explicit legacy storage normalization (read side only; never applied to new publications).
 *
 * Releases published before commit 9be7b80 (2026-09-29) did not persist `extensions` in the
 * release document, although the schema (since 46e42ec) had hashed it as the Zod default `{}`.
 * To re-verify those stored releases we reconstruct exactly the value that was hashed.
 * Applies ONLY to legacy content (`checksumSchemaVersion` absent); v1/v2 content is never touched.
 * Every other established field has been persisted since c8a172b (2026-09-24) and gets no fallback.
 */
export function normalizeLegacyStoredContent(content: BusinessPackContent): BusinessPackContent {
  const record = content as Record<string, unknown>;
  if (record.checksumSchemaVersion === undefined && record.extensions === undefined) {
    return { ...record, extensions: {} } as BusinessPackContent;
  }
  return content;
}

// Backward compatibility aliases
export const BusinessPackReleaseSchema = BusinessPackContentSchema;
export type BusinessPackRelease = BusinessPackContent;
export type ConversationPolicy = z.infer<typeof ConversationPolicySchema>;
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export type FactRegistry = z.infer<typeof FactRegistrySchema>;
export type FactDefinition = z.infer<typeof FactDefinitionSchema>;
export type KnowledgeModelRef = z.infer<typeof KnowledgeModelRefSchema>;
export type OperationalState = z.infer<typeof OperationalStateSchema>;
