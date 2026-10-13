import { z } from 'zod';
import { ClaimClassSchema } from './claim-classes';
import { OkfTenantPolicySchema } from './policy';

export { ClaimClassSchema } from './claim-classes';
export type { ClaimClass } from './claim-classes';

export const EnvironmentIdSchema = z.enum(['dev', 'test', 'staging', 'production']);
export const ConceptIdSchema = z.string().regex(
  /^concept:\/\/[a-z0-9-]+(?:\/[a-z0-9-]+)+$/,
  'conceptId must be a tenant-scoped concept:// URI'
);
export const FactKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export const Sha256Schema = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i);

export const ConceptTypeSchema = z.enum([
  'unknown',
  'department',
  'product_category',
  'product_family',
  'project',
  'room',
  'intent',
  'symptom',
  'diagnostic_step',
  'safety_step',
  'cause',
  'repair',
  'installation',
  'care',
  'compliance_rule',
  'escalation',
  'service',
  'document_family',
]);

/** Portable source text is retained for interchange only; the runtime never reads it. */
export const OkfInterchangeSchema = z.object({
  path: z.string().min(1),
  originalType: z.string().min(1),
  frontmatterExtras: z.record(z.string(), z.unknown()),
  bodyMarkdown: z.string(),
  /** Standard OKF metadata preserved independently of JourneyAX's runtime fields. */
  standardFields: z.record(z.string(), z.unknown()).optional(),
  /** Untrusted controls retained for a human reviewer, never read by the runtime. */
  controlFields: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const PredicateSchema = z.object({
  fact: FactKeySchema,
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'exists', 'not_exists', 'gte', 'lte', 'between']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict().superRefine((predicate, ctx) => {
  const scalarOperators = new Set(['equals', 'not_equals', 'gte', 'lte']);
  const listOperators = new Set(['in', 'not_in', 'between']);
  if (scalarOperators.has(predicate.operator) && predicate.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${predicate.operator} requires value` });
  }
  if (listOperators.has(predicate.operator) && (!predicate.values || predicate.values.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${predicate.operator} requires values` });
  }
  if (predicate.operator === 'between' && predicate.values?.length !== 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'between requires exactly two values' });
  }
});

export const ConditionSchema: z.ZodType<any> = z.lazy(() => z.union([
  PredicateSchema,
  z.object({ all: z.array(ConditionSchema).min(1) }).strict(),
  z.object({ any: z.array(ConditionSchema).min(1) }).strict(),
  z.object({ not: ConditionSchema }).strict(),
]));

export const FactDefinitionSchema = z.object({
  factKey: FactKeySchema,
  type: z.enum(['string', 'number', 'boolean', 'enum', 'array']),
  questionRef: z.string().min(1),
  question: z.string().min(1),
  uiInputType: z.enum(['text', 'select', 'multi_select', 'number', 'slider', 'boolean_toggle', 'card_choice']),
  options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).optional(),
  allowedValues: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();

const SourceBaseSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  checksum: Sha256Schema.optional(),
});

export const SourceSchema = z.discriminatedUnion('kind', [
  SourceBaseSchema.extend({
    kind: z.literal('manufacturer_document'),
    documentId: z.string().min(1),
    uri: z.string().min(1),
    version: z.string().optional(),
    pages: z.array(z.number().int().positive()).optional(),
    scope: z.enum(['sku', 'family', 'category', 'general']),
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('merchant_policy'),
    policyId: z.string().min(1),
    version: z.string().min(1),
    effectiveFrom: z.string().datetime(),
    uri: z.string().optional(),
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('regulation'),
    jurisdiction: z.string().min(1),
    authority: z.string().min(1),
    citation: z.string().min(1),
    officialUri: z.string().min(1),
    effectiveFrom: z.string().datetime(),
    supersededAt: z.string().datetime().optional(),
    documentChecksum: Sha256Schema,
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('trade_expert'),
    personId: z.string().min(1),
    role: z.string().min(1),
    statementRef: z.string().min(1),
    date: z.string().datetime(),
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('catalog_feed'),
    feedId: z.string().min(1),
    snapshotAt: z.string().datetime(),
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('crawl'),
    url: z.string().min(1),
    crawledAt: z.string().datetime(),
  }).strict(),
  SourceBaseSchema.extend({
    kind: z.literal('llm_draft'),
    model: z.string().min(1),
    promptHash: Sha256Schema,
    generatedAt: z.string().datetime(),
  }).strict(),
]);

export const VerificationRecordSchema = z.object({
  recordId: z.string().min(1),
  targetType: z.enum(['concept', 'relationship']),
  targetId: z.string().min(1),
  status: z.enum(['unverified', 'in_review', 'verified']),
  sourceRefs: z.array(z.string()).default([]),
  verifiedBy: z.string().optional(),
  verifierRole: z.string().optional(),
  verifiedAt: z.string().datetime().optional(),
  contentHash: Sha256Schema,
  staleAfter: z.string().datetime().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((record, ctx) => {
  if (record.status === 'verified' && (!record.verifiedBy || !record.verifierRole || !record.verifiedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'verified records require verifiedBy, verifierRole, and verifiedAt',
    });
  }
});

export const RelationshipSchema = z.object({
  relationshipId: z.string().min(1),
  from: ConceptIdSchema,
  to: ConceptIdSchema,
  type: z.enum([
    'child_of',
    'relevant_to',
    'solves',
    'diagnoses',
    'requires',
    'compatible_with',
    'incompatible_with',
    'alternative_to',
    'installed_with',
    'care_for',
    'document_for',
    'escalates_to',
    'cross_sell',
  ]),
  strength: z.enum(['required', 'recommended', 'optional']),
  scope: z.enum(['sku', 'family', 'category', 'general']),
  conditions: ConditionSchema.optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  sourceRefs: z.array(z.string()),
  verificationRef: z.string().optional(),
  claimClasses: z.array(ClaimClassSchema).default([]),
  customerLabel: z.string().optional(),
  effectiveFrom: z.string().datetime().optional(),
  contentHash: Sha256Schema,
  extensions: z.record(z.string(), z.unknown()).optional(),
  interchange: OkfInterchangeSchema.optional(),
}).strict();

export const ConceptSchema = z.object({
  conceptId: ConceptIdSchema,
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  type: ConceptTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  synonyms: z.array(z.string()).default([]),
  customerPhrases: z.array(z.string()).default([]),
  lens: z.enum(['product', 'project', 'problem', 'service', 'care']),
  journeyRef: z.object({
    journeyId: z.string().min(1),
    entryStageId: z.string().min(1).optional(),
  }).strict().optional(),
  riskClass: z.enum(['standard', 'compatibility', 'safety_critical']),
  compatibilitySensitive: z.boolean(),
  requiredFacts: z.array(z.object({
    factKey: FactKeySchema,
    importance: z.enum(['high', 'medium', 'low']),
  }).strict()),
  discriminators: z.array(z.object({
    factKey: FactKeySchema,
    questionRef: z.string().min(1),
    valueMap: z.record(z.string(), ConceptIdSchema).default({}),
    clarifyFirst: z.boolean().default(false),
  }).strict()),
  searchScope: z.object({
    catalogCategoryIds: z.array(z.string()),
    /**
     * Hierarchy scopes: each entry is a catalogue category path from the top (department → group → category). A product
     * is in scope when its own path starts with the entry, compared exactly (case-insensitive). Unlike a name in
     * `catalogCategoryIds`, a path cannot also select a same-named category in another department.
     */
    catalogCategoryPaths: z.array(z.array(z.string().min(1)).min(1).max(8)).optional(),
    enrichmentFacets: z.array(z.string()),
    excludeCategoryIds: z.array(z.string()),
  }).strict(),
  broadQueryPolicy: z.object({
    groupConceptIds: z.array(ConceptIdSchema),
    maxItemsPerGroup: z.number().int().positive().max(10),
    questionRef: z.string().optional(),
    productRetrievalAllowed: z.boolean(),
  }).strict().optional(),
  commercePolicy: z.object({
    addToCart: z.enum(['allowed', 'allowed_with_warning', 'blocked']),
    checkout: z.enum(['allowed', 'requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']),
  }).strict(),
  safety: z.object({
    blocksProducts: z.boolean(),
    stepRefs: z.array(ConceptIdSchema),
  }).strict(),
  evidenceRefs: z.array(z.string()),
  verificationRef: z.string().optional(),
  lifecycle: z.object({ status: z.enum(['active_draft', 'deprecated', 'retired']) }).strict(),
  version: z.number().int().positive(),
  contentHash: Sha256Schema,
  extensions: z.record(z.string(), z.unknown()).optional(),
  interchange: OkfInterchangeSchema.optional(),
  importReview: z.object({ status: z.literal('required'), fields: z.array(z.string()) }).strict().optional(),
}).strict();

/**
 * Immutable, source-backed text available to the runtime retrieval index.
 *
 * The source record carries provenance; this record carries the exact extracted
 * text that was evaluated and published with the OKF release. Embeddings are an
 * index implementation detail and are deliberately excluded from the release
 * contract/checksum.
 */
export const EvidenceChunkSchema = z.object({
  chunkId: z.string().min(1),
  sourceRef: z.string().min(1),
  conceptIds: z.array(ConceptIdSchema).min(1),
  claimClasses: z.array(ClaimClassSchema).default([]),
  title: z.string().min(1),
  content: z.string().min(1),
  applicability: z.object({
    scope: z.enum(['sku', 'family', 'category', 'general']),
    refs: z.array(z.string()).default([]),
  }).strict(),
  ordinal: z.number().int().nonnegative(),
  uri: z.string().min(1).optional(),
  contentHash: Sha256Schema,
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Every mode the gate can return. */
export const OkfResponseModeSchema = z.enum([
  'direct_results',
  'overview_then_ask',
  'clarify_then_search',
  'safety_then_diagnose',
  'project_journey',
  'service_intake',
  'evidence_answer',
  'operational_journey',
  'legacy_search',
  'knowledge_unavailable',
  'no_match',
]);
export type OkfResponseMode = z.infer<typeof OkfResponseModeSchema>;

/**
 * A tenant-authored acceptance scenario. It is executed against the draft at
 * publication time; a failing scenario blocks the release.
 */
export const AcceptanceScenarioSchema = z.object({
  scenarioId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/i),
  description: z.string().max(300).optional(),
  message: z.string().min(1).max(500),
  knownFacts: z.record(FactKeySchema, z.union([z.string(), z.number(), z.boolean()])).optional(),
  declinedQuestions: z.array(z.string().min(1)).max(20).optional(),
  forceShowResults: z.boolean().optional(),
  expect: z.object({
    mode: OkfResponseModeSchema.optional(),
    conceptId: ConceptIdSchema.optional(),
    retrievalPermission: z.enum(['allowed', 'blocked']).optional(),
    recommendation: z.enum(['blocked', 'category_examples', 'matched_to_stated_needs', 'verified_recommendation']).optional(),
    clarificationFactKey: FactKeySchema.optional(),
    noClarification: z.boolean().optional(),
    claimsIncluded: z.array(ClaimClassSchema).max(10).optional(),
    claimsExcluded: z.array(ClaimClassSchema).max(10).optional(),
    commerce: z.object({
      addToCart: z.enum(['allowed', 'allowed_with_warning', 'blocked']).optional(),
      checkout: z.enum(['allowed', 'requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']).optional(),
    }).strict().optional(),
    reasonCodesInclude: z.array(z.string().min(1)).max(10).optional(),
    /** Concepts that must be among the unverified "Have you considered?" suggestions. */
    suggestsConceptIds: z.array(ConceptIdSchema).max(10).optional(),
    noSuggestions: z.boolean().optional(),
  }).strict(),
}).strict();
export type OkfAcceptanceScenario = z.infer<typeof AcceptanceScenarioSchema>;

export const OkfReleaseContentSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  modelId: z.string().min(1),
  factRegistry: z.array(FactDefinitionSchema),
  concepts: z.array(ConceptSchema),
  relationships: z.array(RelationshipSchema),
  sources: z.array(SourceSchema),
  evidenceChunks: z.array(EvidenceChunkSchema),
  verifications: z.array(VerificationRecordSchema),
  index: z.object({
    embeddingModel: z.string().min(1),
    embeddingModelVersion: z.string().min(1),
    chunkingVersion: z.string().min(1),
    indexChecksum: Sha256Schema,
    builtAt: z.string().datetime(),
    sourceChecksum: Sha256Schema,
  }).strict(),
  evaluation: z.object({
    reportId: z.string().min(1),
    passed: z.boolean(),
    evaluatedAt: z.string().datetime(),
    scenarioCount: z.number().int().nonnegative(),
    failedScenarioCount: z.number().int().nonnegative(),
  }).strict(),
  /** Tenant decision policy: intent vocabulary, thresholds, verifier roles and customer-facing messages. */
  policy: OkfTenantPolicySchema.optional(),
  /** Tenant acceptance scenarios executed at publication. */
  acceptanceScenarios: z.array(AcceptanceScenarioSchema).max(500).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** Merchant-editable data never includes server-owned evaluation or index state. */
export const OkfDraftContentSchema = OkfReleaseContentSchema.omit({ index: true, evaluation: true });
export type OkfDraftContent = z.infer<typeof OkfDraftContentSchema>;

export const OkfReleaseEnvelopeSchema = z.object({
  releaseId: z.string().min(1),
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  environmentId: EnvironmentIdSchema,
  version: z.string().min(1),
  checksum: Sha256Schema,
  status: z.enum(['building', 'ready', 'failed', 'retired']),
  artifactUri: z.string().min(1).optional(),
  artifact: z.object({
    status: z.enum(['pending', 'ready', 'failed']),
    uri: z.string().min(1).optional(),
    checksum: Sha256Schema.optional(),
    verifiedChecksum: Sha256Schema.optional(),
    exportedAt: z.coerce.date().optional(),
    error: z.string().optional(),
  }).strict().optional(),
  content: OkfReleaseContentSchema,
  publishedAt: z.coerce.date(),
  publishedBy: z.string().min(1),
  notes: z.string().optional(),
}).strict();

export const OkfRevocationEventSchema = z.object({
  eventId: z.string().min(1),
  revocationId: z.string().min(1),
  eventType: z.enum(['created', 'lifted', 'expired']),
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  environmentId: EnvironmentIdSchema,
  releaseId: z.string().optional(),
  conceptIds: z.array(ConceptIdSchema).min(1),
  cascade: z.enum(['none', 'descendants']),
  effect: z.object({ suppressClaims: z.boolean(), suppressRetrieval: z.boolean() }).strict(),
  reason: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  correctedReleaseId: z.string().optional(),
}).strict();

export type OkfConcept = z.infer<typeof ConceptSchema>;
export type OkfRelationship = z.infer<typeof RelationshipSchema>;
export type OkfSource = z.infer<typeof SourceSchema>;
export type OkfEvidenceChunk = z.infer<typeof EvidenceChunkSchema>;
export type OkfVerificationRecord = z.infer<typeof VerificationRecordSchema>;
export type OkfReleaseContent = z.infer<typeof OkfReleaseContentSchema>;
export type OkfReleaseEnvelope = z.infer<typeof OkfReleaseEnvelopeSchema>;
export type OkfRevocationEvent = z.infer<typeof OkfRevocationEventSchema>;
