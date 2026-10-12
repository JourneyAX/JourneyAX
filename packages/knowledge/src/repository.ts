import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import {
  OkfReleaseEnvelopeSchema,
  OkfReleaseContentSchema,
  OkfRevocationEventSchema,
  type OkfReleaseContent,
  type OkfReleaseEnvelope,
  type OkfRevocationEvent,
} from './contracts';
import { computeKnowledgeChecksum } from './checksum';
import { validateOkfReleaseContent } from './validator';
import { archiveOkfBundle } from './okf-archive';
import { exportOkfBundle } from './interchange';
import { buildOkfIndexMetadata, evaluateOkfDraft, type OkfEvaluationScenarioResult } from './server-evaluation';
import { GcsOkfArtifactStore, okfArtifactChecksum, okfArtifactKey, type OkfArtifactStore } from './artifact-store';

export const COLLECTION_OKF_RELEASES = 'okf_releases';
export const COLLECTION_OKF_EVALUATION_REPORTS = 'okf_evaluation_reports';
export const COLLECTION_OKF_CONCEPTS = 'okf_concepts';
export const COLLECTION_OKF_FACT_DEFINITIONS = 'okf_fact_definitions';
export const COLLECTION_OKF_RELATIONSHIPS = 'okf_relationships';
export const COLLECTION_OKF_SOURCES = 'okf_sources';
export const COLLECTION_OKF_EVIDENCE_CHUNKS = 'okf_evidence_chunks';
export const COLLECTION_OKF_VERIFICATION_RECORDS = 'okf_verification_records';
export const COLLECTION_OKF_REVOCATION_EVENTS = 'okf_revocation_events';
export const COLLECTION_OKF_REVOCATION_ARCHIVE = 'okf_revocation_events_archive';
export const COLLECTION_OKF_ARTIFACT_POLICIES = 'okf_artifact_policies';
const COLLECTION_OUTBOX_EVENTS = 'outbox_events';

export class OkfIntegrityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OkfIntegrityError';
  }
}

const RELEASE_COLLECTIONS = {
  factRegistry: COLLECTION_OKF_FACT_DEFINITIONS,
  concepts: COLLECTION_OKF_CONCEPTS,
  relationships: COLLECTION_OKF_RELATIONSHIPS,
  sources: COLLECTION_OKF_SOURCES,
  evidenceChunks: COLLECTION_OKF_EVIDENCE_CHUNKS,
  verifications: COLLECTION_OKF_VERIFICATION_RECORDS,
} as const;
type ReleaseCollectionKey = keyof typeof RELEASE_COLLECTIONS;

/** Hydrates new metadata-only releases, while allowing already-published legacy envelopes. */
export async function hydrateOkfReleaseEnvelope(db: Db, stored: any, session?: any): Promise<OkfReleaseEnvelope> {
  if (stored?.content !== undefined) {
    const { _id, ...legacyEnvelope } = stored;
    return verifyOkfReleaseEnvelope(legacyEnvelope);
  }
  if (stored?.contentStorage !== 'release_scoped_v1' || !stored.contentHeader || !stored.collectionChecksums) {
    throw new OkfIntegrityError('schema_invalid', 'Invalid OKF release storage metadata');
  }
  const scope = { tenantId: stored.tenantId, environmentId: stored.environmentId, releaseId: stored.releaseId };
  const content: Record<string, unknown> = { ...stored.contentHeader };
  for (const [key, collectionName] of Object.entries(RELEASE_COLLECTIONS) as Array<[ReleaseCollectionKey, string]>) {
    const rows = await db.collection(collectionName).find(scope, session ? { session } : undefined)
      .sort({ _releaseOrdinal: 1 }).toArray();
    // Only indexed records belong to the metadata-only release representation.
    // Unindexed stray rows cannot expand or reorder the immutable content.
    const releaseRows = rows.filter((row: any) => Number.isInteger(row._releaseOrdinal));
    const records = releaseRows.map((row: any, index: number) => {
      if (row._releaseOrdinal !== index) {
        throw new OkfIntegrityError('collection_checksum_mismatch', `OKF ${key} release order is incomplete`);
      }
      const { _id, _releaseOrdinal, releaseId, environmentId, ...record } = row;
      if (key !== 'concepts') delete record.tenantId;
      return record;
    });
    if (computeKnowledgeChecksum(records) !== stored.collectionChecksums[key]) {
      throw new OkfIntegrityError('collection_checksum_mismatch', `OKF ${key} release records failed integrity verification`);
    }
    content[key] = records;
  }
  const { contentStorage, contentHeader, collectionChecksums, _id, ...metadata } = stored;
  return verifyOkfReleaseEnvelope({ ...metadata, content });
}

export interface PublishOkfReleaseInput {
  releaseId: string;
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  version: string;
  content: OkfReleaseContent;
  artifactUri?: string;
  publishedBy: string;
  notes?: string;
  evaluationScenarios?: OkfEvaluationScenarioResult[];
  sourceDraftChecksum?: string;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Rows written by an earlier build may carry nulls for absent optional fields; treat them as absent. */
function withoutNullOptionals(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const envelope: Record<string, unknown> = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, entry]) => entry !== null));
  if (envelope.artifact && typeof envelope.artifact === 'object') {
    envelope.artifact = Object.fromEntries(Object.entries(envelope.artifact as Record<string, unknown>).filter(([, entry]) => entry !== null));
  }
  return envelope;
}

export function verifyOkfReleaseEnvelope(
  input: unknown,
  expected?: { tenantId?: string; environmentId?: string; releaseId?: string; version?: string; checksum?: string }
): OkfReleaseEnvelope {
  const parsed = OkfReleaseEnvelopeSchema.safeParse(withoutNullOptionals(input));
  if (!parsed.success) throw new OkfIntegrityError('schema_invalid', `Invalid OKF release envelope: ${parsed.error.message}`);
  const release = parsed.data;
  const checksum = computeKnowledgeChecksum(release.content);
  if (release.checksum.replace(/^sha256:/, '') !== checksum) throw new OkfIntegrityError('checksum_mismatch', 'OKF release content checksum mismatch');
  if (expected?.tenantId && release.tenantId !== expected.tenantId) throw new OkfIntegrityError('tenant_mismatch', 'OKF release tenant mismatch');
  if (expected?.environmentId && release.environmentId !== expected.environmentId) throw new OkfIntegrityError('environment_mismatch', 'OKF release environment mismatch');
  if (expected?.releaseId && release.releaseId !== expected.releaseId) throw new OkfIntegrityError('release_mismatch', 'OKF release ID mismatch');
  if (expected?.version && release.version !== expected.version) throw new OkfIntegrityError('version_mismatch', 'OKF release version mismatch');
  if (expected?.checksum && checksum !== expected.checksum.replace(/^sha256:/, '')) throw new OkfIntegrityError('reference_checksum_mismatch', 'OKF release reference checksum mismatch');
  // Publication policy is applied once, before the immutable release is written.
  // Loading checks structure, stored checksum, and the caller's pinned identity;
  // a later policy tightening must not invalidate an already-published release.
  return release;
}

async function withOptionalTransaction<T>(db: Db, operation: (session?: any) => Promise<T>): Promise<T> {
  const client = (db as any).client;
  if (!client || typeof client.startSession !== 'function') {
    if (process.env.NODE_ENV === 'production') {
      throw new OkfIntegrityError('transaction_unavailable', 'Transactional OKF publication requires a MongoDB session');
    }
    return operation(undefined);
  }
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await operation(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function publishOkfRelease(db: Db, input: PublishOkfReleaseInput): Promise<OkfReleaseEnvelope> {
  // Parse exactly once and use the parsed value for validation, hashing,
  // storage and normalized records. Zod defaults are therefore checksum-bound
  // instead of creating two subtly different representations.
  const content = OkfReleaseContentSchema.parse(input.content);
  const validation = validateOkfReleaseContent(content, input.tenantId);
  if (!validation.valid) throw new OkfIntegrityError('semantic_invalid', validation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; '));
  if (process.env.NODE_ENV === 'production' && !input.evaluationScenarios) {
    throw new OkfIntegrityError('evaluation_missing', 'Production OKF publication requires server-run evaluation evidence');
  }
  if (input.evaluationScenarios) {
    const { index: _index, evaluation: _evaluation, ...draft } = content;
    const expectedScenarios = evaluateOkfDraft(
      draft, input.tenantId, input.environmentId, input.releaseId, content.evaluation.evaluatedAt,
    );
    const expectedIndex = buildOkfIndexMetadata(draft, content.evaluation.evaluatedAt);
    const reportId = `eval-${computeKnowledgeChecksum(input.evaluationScenarios)}`;
    if (content.evaluation.reportId !== reportId ||
      computeKnowledgeChecksum(input.evaluationScenarios) !== computeKnowledgeChecksum(expectedScenarios) ||
      computeKnowledgeChecksum(content.index) !== computeKnowledgeChecksum(expectedIndex) ||
      content.evaluation.scenarioCount !== input.evaluationScenarios.length ||
      content.evaluation.failedScenarioCount !== input.evaluationScenarios.filter((result) => !result.passed).length ||
      input.evaluationScenarios.some((result) => !result.passed)) {
      throw new OkfIntegrityError('evaluation_mismatch', 'Server evaluation report does not match the release');
    }
  }
  const checksum = computeKnowledgeChecksum(content);
  const envelope: OkfReleaseEnvelope = {
    releaseId: input.releaseId,
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    version: input.version,
    checksum,
    status: 'ready',
    artifactUri: input.artifactUri,
    artifact: { status: 'pending' },
    content,
    publishedAt: new Date(),
    publishedBy: input.publishedBy,
    notes: input.notes,
  };
  OkfReleaseEnvelopeSchema.parse(envelope);

  return withOptionalTransaction(db, async (session) => {
    const options = session ? { session } : undefined;
    const releases = db.collection(COLLECTION_OKF_RELEASES);
    const existing = await releases.findOne({ tenantId: input.tenantId, environmentId: input.environmentId, releaseId: input.releaseId }, options);
    if (existing) {
      const hydrated = await hydrateOkfReleaseEnvelope(db, existing, session);
      const verified = verifyOkfReleaseEnvelope(hydrated, {
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        releaseId: input.releaseId,
        version: input.version,
        checksum,
      });
      return verified;
    }

    const scope = { tenantId: input.tenantId, environmentId: input.environmentId, releaseId: input.releaseId };
    const { content: _content, ...releaseMetadata } = envelope;
    const { factRegistry, concepts, relationships, sources, evidenceChunks, verifications, ...contentHeader } = content;
    const releaseRecords = { factRegistry, concepts, relationships, sources, evidenceChunks, verifications };
    const collectionChecksums = Object.fromEntries(Object.entries(releaseRecords)
      .map(([key, values]) => [key, computeKnowledgeChecksum(values)]));
    // MongoDB stores `undefined` as null, which the strict envelope contract rejects on read.
    await releases.insertOne(omitUndefined({
      ...releaseMetadata, contentStorage: 'release_scoped_v1', contentHeader, collectionChecksums,
    }) as any, options);
    if (input.evaluationScenarios) {
      await db.collection(COLLECTION_OKF_EVALUATION_REPORTS).insertOne({
        ...scope,
        reportId: content.evaluation.reportId,
        releaseChecksum: checksum,
        sourceDraftChecksum: input.sourceDraftChecksum,
        scenarios: input.evaluationScenarios,
        evaluatedAt: content.evaluation.evaluatedAt,
      } as any, options);
    }
    for (const [key, collectionName] of Object.entries(RELEASE_COLLECTIONS) as Array<[ReleaseCollectionKey, string]>) {
      const values = releaseRecords[key];
      if (values.length) await db.collection(collectionName).insertMany(values.map((value, index) => ({
        ...scope, ...value, _releaseOrdinal: index,
      })) as any[], options);
    }
    await db.collection(COLLECTION_OUTBOX_EVENTS).insertOne({
      eventId: `evt_okf_export_${randomUUID()}`,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      eventType: 'okf.release.export_requested',
      payload: { releaseId: input.releaseId, version: input.version, checksum },
      status: 'pending', attempts: 0, maxAttempts: 5, createdAt: new Date(),
    }, options);
    return envelope;
  });
}

export async function loadPinnedOkfRelease(
  db: Db,
  ref: { tenantId: string; environmentId: string; releaseId: string; version: string; checksum: string },
  session?: any
): Promise<{ release: OkfReleaseEnvelope; activeRevocations: OkfRevocationEvent[] }> {
  const stored = await db.collection(COLLECTION_OKF_RELEASES).findOne({
    tenantId: ref.tenantId,
    environmentId: ref.environmentId,
    releaseId: ref.releaseId,
    version: ref.version,
  }, session ? { session } : undefined);
  if (!stored) throw new OkfIntegrityError('not_found', `OKF release '${ref.releaseId}' not found`);
  const release = verifyOkfReleaseEnvelope(await hydrateOkfReleaseEnvelope(db, stored, session), ref);
  if (release.status !== 'ready') throw new OkfIntegrityError('not_ready', `OKF release '${ref.releaseId}' is ${release.status}`);
  return { release, activeRevocations: await loadActiveOkfRevocations(db, ref.tenantId, ref.environmentId, ref.releaseId, new Date(), session) };
}

export async function assertOkfReferenceReady(
  db: Db,
  ref: { releaseId: string; version: string; checksum: string },
  scope: { tenantId: string; environmentId: string },
  session?: any,
  artifactStore?: OkfArtifactStore
): Promise<OkfReleaseEnvelope> {
  const loaded = await loadPinnedOkfRelease(db, { ...scope, ...ref }, session);
  const policy = await db.collection(COLLECTION_OKF_ARTIFACT_POLICIES).findOne(scope, session ? { session } : undefined);
  if (policy?.artifactRequired === true) {
    const artifact = loaded.release.artifact;
    if (artifact?.status !== 'ready' || !artifact.uri || !artifact.checksum ||
        artifact.checksum !== artifact.verifiedChecksum || loaded.release.artifactUri !== artifact.uri) {
      throw new OkfIntegrityError('artifact_not_ready', 'Required OKF export artifact has not been verified');
    }
    const key = okfArtifactKey({
      ...scope, releaseId: ref.releaseId, checksum: ref.checksum.replace(/^sha256:/, ''),
    });
    if (!artifact.uri.startsWith('gs://') || !artifact.uri.endsWith(`/${key}`)) {
      throw new OkfIntegrityError('artifact_not_ready', 'Required OKF export artifact URI does not match the pinned release');
    }
    if (!artifactStore && process.env.OKF_ARTIFACT_BUCKET &&
        artifact.uri !== `gs://${process.env.OKF_ARTIFACT_BUCKET}/${key}`) {
      throw new OkfIntegrityError('artifact_not_ready', 'Required OKF artifact bucket does not match configuration');
    }
    const store = artifactStore || (process.env.OKF_ARTIFACT_BUCKET
      ? new GcsOkfArtifactStore(process.env.OKF_ARTIFACT_BUCKET) : undefined);
    if (!store) throw new OkfIntegrityError('artifact_not_ready', 'Required OKF artifact store is unavailable');
    try {
      if (!await store.verify(key, artifact.checksum)) {
        throw new OkfIntegrityError('artifact_not_ready', 'Required OKF artifact object failed checksum verification');
      }
    } catch (error) {
      if (error instanceof OkfIntegrityError) throw error;
      throw new OkfIntegrityError('artifact_not_ready', 'Required OKF artifact object could not be verified');
    }
  }
  return loaded.release;
}

/** The durable outbox worker performs this operation and retries it on failure. */
export async function processOkfExport(
  db: Db,
  store: OkfArtifactStore,
  ref: { tenantId: string; environmentId: string; releaseId: string; version: string; checksum: string }
): Promise<{ uri: string; checksum: string }> {
  const { release } = await loadPinnedOkfRelease(db, ref);
  const scope = { tenantId: ref.tenantId, environmentId: ref.environmentId, releaseId: ref.releaseId, version: ref.version, checksum: ref.checksum };
  try {
    const bytes = archiveOkfBundle(exportOkfBundle(release));
    const checksum = okfArtifactChecksum(bytes);
    const key = okfArtifactKey({ ...ref, checksum: ref.checksum.replace(/^sha256:/, '') });
    const uri = await store.put(key, bytes, checksum);
    if (!await store.verify(key, checksum)) throw new OkfIntegrityError('artifact_checksum_mismatch', 'Uploaded OKF artifact did not verify');
    const existing = release.artifact;
    if (existing?.status === 'ready' && (existing.uri !== uri || existing.checksum !== checksum)) {
      throw new OkfIntegrityError('artifact_collision', 'Ready OKF artifact metadata differs from immutable export');
    }
    const result = await db.collection(COLLECTION_OKF_RELEASES).updateOne(
      scope,
      { $set: { artifactUri: uri, artifact: { status: 'ready', uri, checksum, verifiedChecksum: checksum, exportedAt: new Date() } } }
    );
    if (result.matchedCount !== 1) throw new OkfIntegrityError('release_changed', 'OKF release changed during export');
    return { uri, checksum };
  } catch (error: any) {
    if (release.artifact?.status !== 'ready') {
      await db.collection(COLLECTION_OKF_RELEASES).updateOne(
        { ...scope, 'artifact.status': { $ne: 'ready' } },
        { $set: { artifact: { status: 'failed', error: String(error?.message || error).slice(0, 500) } } }
      );
    }
    throw error;
  }
}

/** Stored events carry the driver's `_id`; the contract itself is strict, so it is dropped before parsing. */
function parseStoredRevocation(raw: any): OkfRevocationEvent {
  const { _id, ...event } = raw || {};
  return OkfRevocationEventSchema.parse(event);
}

export async function appendOkfRevocationEvent(
  db: Db,
  event: Omit<OkfRevocationEvent, 'eventId' | 'createdAt'> & { eventId?: string; createdAt?: Date }
): Promise<OkfRevocationEvent> {
  const parsed = OkfRevocationEventSchema.parse({
    ...event,
    eventId: event.eventId || `okfrev_evt_${randomUUID()}`,
    createdAt: event.createdAt || new Date(),
  });
  if (parsed.expiresAt <= parsed.createdAt) throw new OkfIntegrityError('invalid_expiry', 'Revocation expiresAt must be after createdAt');
  const existingEvents = await db.collection(COLLECTION_OKF_REVOCATION_EVENTS)
    .find({ tenantId: parsed.tenantId, environmentId: parsed.environmentId, revocationId: parsed.revocationId })
    .sort({ createdAt: 1 }).toArray();
  const previous = existingEvents.at(-1) as any;
  if (parsed.eventType === 'created' && previous) throw new OkfIntegrityError('invalid_transition', 'Revocation already exists; append lifted/expired instead');
  if (parsed.eventType !== 'created' && (!previous || previous.eventType !== 'created')) throw new OkfIntegrityError('invalid_transition', 'Only an active created revocation may be lifted or expired');
  if (parsed.eventType === 'lifted' && !parsed.correctedReleaseId) {
    throw new OkfIntegrityError('corrected_release_required', 'A revocation can only be lifted by pointing at the corrected release');
  }
  try {
    await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).insertOne(parsed as any);
  } catch (error: any) {
    if (error?.code === 11000) {
      throw new OkfIntegrityError('invalid_transition', `Revocation ${parsed.revocationId} already has a '${parsed.eventType}' event`);
    }
    throw error;
  }
  return parsed;
}

export interface CreateOkfRevocationInput {
  tenantId: string;
  environmentId: string;
  /** Release whose guidance is being withdrawn; its concepts are verified to exist. */
  releaseId: string;
  conceptIds: string[];
  cascade: 'none' | 'descendants';
  effect: { suppressClaims: boolean; suppressRetrieval: boolean };
  reason: string;
  createdBy: string;
  expiresAt: Date;
  revocationId?: string;
  now?: Date;
}

async function loadScopedRelease(db: Db, scope: { tenantId: string; environmentId: string }, releaseId: string): Promise<OkfReleaseEnvelope> {
  const stored = await db.collection(COLLECTION_OKF_RELEASES).findOne({ ...scope, releaseId });
  if (!stored) throw new OkfIntegrityError('release_not_found', `OKF release ${releaseId} not found in this tenant/environment`);
  return hydrateOkfReleaseEnvelope(db, stored);
}

export async function createOkfRevocation(db: Db, input: CreateOkfRevocationInput): Promise<OkfRevocationEvent> {
  if (!input.createdBy.trim()) throw new OkfIntegrityError('actor_required', 'A revocation must name the authenticated principal who created it');
  const scope = { tenantId: input.tenantId, environmentId: input.environmentId };
  const release = await loadScopedRelease(db, scope, input.releaseId);
  const known = new Set(release.content.concepts.map((concept) => concept.conceptId));
  const unknown = input.conceptIds.filter((id) => !known.has(id));
  if (unknown.length) throw new OkfIntegrityError('unknown_concept', `Concepts not in release ${input.releaseId}: ${unknown.join(', ')}`);
  return appendOkfRevocationEvent(db, {
    tenantId: scope.tenantId,
    environmentId: release.environmentId,
    revocationId: input.revocationId || `okfrev_${randomUUID()}`,
    eventType: 'created',
    releaseId: input.releaseId,
    conceptIds: [...new Set(input.conceptIds)],
    cascade: input.cascade,
    effect: input.effect,
    reason: input.reason,
    createdBy: input.createdBy,
    expiresAt: input.expiresAt,
    createdAt: input.now,
  });
}

export interface LiftOkfRevocationInput {
  tenantId: string;
  environmentId: string;
  revocationId: string;
  correctedReleaseId: string;
  liftedBy: string;
  reason: string;
  now?: Date;
}

/**
 * Lifting is never an administrative toggle: the corrected release must exist in the same scope and, for every
 * revoked concept it still contains, carry different content than the revoked release (or have retired it).
 */
export async function liftOkfRevocation(db: Db, input: LiftOkfRevocationInput): Promise<OkfRevocationEvent> {
  if (!input.liftedBy.trim()) throw new OkfIntegrityError('actor_required', 'Lifting a revocation must name the authenticated principal');
  const now = input.now || new Date();
  const scope = { tenantId: input.tenantId, environmentId: input.environmentId };
  const history = (await db.collection(COLLECTION_OKF_REVOCATION_EVENTS)
    .find({ ...scope, revocationId: input.revocationId }).sort({ createdAt: 1 }).toArray())
    .map((raw) => parseStoredRevocation(raw));
  const created = history.find((event) => event.eventType === 'created');
  if (!created) throw new OkfIntegrityError('revocation_not_found', `Revocation ${input.revocationId} not found`);
  if (history.some((event) => event.eventType !== 'created') || created.expiresAt <= now) {
    throw new OkfIntegrityError('invalid_transition', 'Only an active revocation may be lifted');
  }
  if (input.correctedReleaseId === created.releaseId) {
    throw new OkfIntegrityError('corrected_release_invalid', 'The corrected release must differ from the revoked release');
  }
  const corrected = await loadScopedRelease(db, scope, input.correctedReleaseId);
  const revoked = created.releaseId ? await loadScopedRelease(db, scope, created.releaseId) : undefined;
  const hashes = (release: OkfReleaseEnvelope | undefined) =>
    new Map((release?.content.concepts || []).map((concept) => [concept.conceptId, concept] as const));
  const before = hashes(revoked);
  const after = hashes(corrected);
  const unresolved = created.conceptIds.filter((id) => {
    const next = after.get(id);
    if (!next || next.lifecycle.status === 'retired') return false;
    const prior = before.get(id);
    return !prior || prior.contentHash === next.contentHash;
  });
  if (unresolved.length) {
    throw new OkfIntegrityError('corrected_release_invalid', `Corrected release still carries unchanged content for: ${unresolved.join(', ')}`);
  }
  return appendOkfRevocationEvent(db, {
    ...created,
    eventType: 'lifted',
    reason: input.reason || created.reason,
    createdBy: input.liftedBy,
    createdAt: now,
    correctedReleaseId: input.correctedReleaseId,
  } as any);
}

export type OkfRevocationStatus = 'active' | 'lifted' | 'expired';
export interface OkfRevocationSummary {
  revocationId: string;
  status: OkfRevocationStatus;
  created: OkfRevocationEvent;
  closedBy?: OkfRevocationEvent;
}

export async function listOkfRevocations(
  db: Db, scope: { tenantId: string; environmentId: string }, now = new Date(),
): Promise<OkfRevocationSummary[]> {
  const events = (await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).find(scope).sort({ createdAt: 1 }).toArray())
    .map((raw) => parseStoredRevocation(raw));
  const byId = new Map<string, OkfRevocationEvent[]>();
  for (const event of events) byId.set(event.revocationId, [...(byId.get(event.revocationId) || []), event]);
  return [...byId.entries()].flatMap(([revocationId, chain]) => {
    const created = chain.find((event) => event.eventType === 'created');
    if (!created) return [];
    const closedBy = chain.find((event) => event.eventType !== 'created');
    const status: OkfRevocationStatus = closedBy ? (closedBy.eventType === 'lifted' ? 'lifted' : 'expired')
      : created.expiresAt > now ? 'active' : 'expired';
    return [{ revocationId, status, created, ...(closedBy ? { closedBy } : {}) }];
  });
}

/**
 * Moves fully terminated revocations (lifted, or expired before `before`) to an archive collection so the
 * latest-head scan used by the safety-critical read path stays bounded. Active revocations are never touched.
 */
export async function pruneOkfRevocationEvents(
  db: Db, input: { tenantId: string; environmentId: string; before: Date; now?: Date },
): Promise<{ archived: number }> {
  const scope = { tenantId: input.tenantId, environmentId: input.environmentId };
  const summaries = await listOkfRevocations(db, scope, input.now || new Date());
  const terminal = summaries.filter((summary) => summary.status !== 'active' &&
    (summary.closedBy?.createdAt ?? summary.created.expiresAt) < input.before);
  let archived = 0;
  for (const summary of terminal) {
    const chain = await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).find({ ...scope, revocationId: summary.revocationId }).toArray();
    await db.collection(COLLECTION_OKF_REVOCATION_ARCHIVE).insertMany(chain.map((event: any) => ({ ...event, archivedAt: new Date() })));
    await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).deleteMany({ ...scope, revocationId: summary.revocationId });
    archived += chain.length;
  }
  return { archived };
}

export async function loadActiveOkfRevocations(
  db: Db,
  tenantId: string,
  environmentId: string,
  releaseId?: string,
  now = new Date(),
  session?: any
): Promise<OkfRevocationEvent[]> {
  // Safety-critical read: primary + majority so a just-created revocation is never missed on a lagging secondary.
  const events = await db.collection(COLLECTION_OKF_REVOCATION_EVENTS, { readPreference: 'primary', readConcern: { level: 'majority' } } as any).find({
    tenantId,
    environmentId,
    ...(releaseId ? { $or: [{ releaseId }, { releaseId: { $exists: false } }] } : {}),
  }, session ? { session } : undefined).sort({ createdAt: 1 }).toArray();
  const latest = new Map<string, OkfRevocationEvent>();
  for (const raw of events) {
    const event = parseStoredRevocation(raw);
    // A closing event always supersedes `created`, regardless of timestamp resolution or read order.
    const current = latest.get(event.revocationId);
    if (!current || current.eventType === 'created') latest.set(event.revocationId, event);
  }
  return [...latest.values()].filter((event) => event.eventType === 'created' && event.expiresAt > now);
}
