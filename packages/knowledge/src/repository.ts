import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import {
  OkfReleaseEnvelopeSchema,
  OkfRevocationEventSchema,
  type OkfReleaseContent,
  type OkfReleaseEnvelope,
  type OkfRevocationEvent,
} from './contracts';
import { computeKnowledgeChecksum } from './checksum';
import { validateOkfReleaseContent } from './validator';

export const COLLECTION_OKF_RELEASES = 'okf_releases';
export const COLLECTION_OKF_CONCEPTS = 'okf_concepts';
export const COLLECTION_OKF_RELATIONSHIPS = 'okf_relationships';
export const COLLECTION_OKF_SOURCES = 'okf_sources';
export const COLLECTION_OKF_EVIDENCE_CHUNKS = 'okf_evidence_chunks';
export const COLLECTION_OKF_VERIFICATION_RECORDS = 'okf_verification_records';
export const COLLECTION_OKF_REVOCATION_EVENTS = 'okf_revocation_events';

export class OkfIntegrityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OkfIntegrityError';
  }
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
}

export function verifyOkfReleaseEnvelope(
  input: unknown,
  expected?: { tenantId?: string; environmentId?: string; releaseId?: string; version?: string; checksum?: string }
): OkfReleaseEnvelope {
  const parsed = OkfReleaseEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new OkfIntegrityError('schema_invalid', `Invalid OKF release envelope: ${parsed.error.message}`);
  const release = parsed.data;
  const checksum = computeKnowledgeChecksum(release.content);
  if (release.checksum.replace(/^sha256:/, '') !== checksum) throw new OkfIntegrityError('checksum_mismatch', 'OKF release content checksum mismatch');
  if (expected?.tenantId && release.tenantId !== expected.tenantId) throw new OkfIntegrityError('tenant_mismatch', 'OKF release tenant mismatch');
  if (expected?.environmentId && release.environmentId !== expected.environmentId) throw new OkfIntegrityError('environment_mismatch', 'OKF release environment mismatch');
  if (expected?.releaseId && release.releaseId !== expected.releaseId) throw new OkfIntegrityError('release_mismatch', 'OKF release ID mismatch');
  if (expected?.version && release.version !== expected.version) throw new OkfIntegrityError('version_mismatch', 'OKF release version mismatch');
  if (expected?.checksum && checksum !== expected.checksum.replace(/^sha256:/, '')) throw new OkfIntegrityError('reference_checksum_mismatch', 'OKF release reference checksum mismatch');
  const validation = validateOkfReleaseContent(release.content, release.tenantId);
  if (!validation.valid) throw new OkfIntegrityError('semantic_invalid', validation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; '));
  return release;
}

async function withOptionalTransaction<T>(db: Db, operation: (session?: any) => Promise<T>): Promise<T> {
  const client = (db as any).client;
  if (!client || typeof client.startSession !== 'function') return operation(undefined);
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
  const validation = validateOkfReleaseContent(input.content, input.tenantId);
  if (!validation.valid) throw new OkfIntegrityError('semantic_invalid', validation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; '));
  const checksum = computeKnowledgeChecksum(input.content);
  const envelope: OkfReleaseEnvelope = {
    releaseId: input.releaseId,
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    version: input.version,
    checksum,
    status: 'ready',
    artifactUri: input.artifactUri,
    content: input.content,
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
      const verified = verifyOkfReleaseEnvelope(existing, {
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        releaseId: input.releaseId,
        version: input.version,
        checksum,
      });
      return verified;
    }

    await releases.insertOne(envelope as any, options);
    const scope = { tenantId: input.tenantId, environmentId: input.environmentId, releaseId: input.releaseId };
    if (input.content.concepts.length) await db.collection(COLLECTION_OKF_CONCEPTS).insertMany(input.content.concepts.map((value) => ({ ...scope, ...value })) as any[], options);
    if (input.content.relationships.length) await db.collection(COLLECTION_OKF_RELATIONSHIPS).insertMany(input.content.relationships.map((value) => ({ ...scope, ...value })) as any[], options);
    if (input.content.sources.length) await db.collection(COLLECTION_OKF_SOURCES).insertMany(input.content.sources.map((value) => ({ ...scope, ...value })) as any[], options);
    if (input.content.evidenceChunks.length) await db.collection(COLLECTION_OKF_EVIDENCE_CHUNKS).insertMany(input.content.evidenceChunks.map((value) => ({ ...scope, ...value })) as any[], options);
    if (input.content.verifications.length) await db.collection(COLLECTION_OKF_VERIFICATION_RECORDS).insertMany(input.content.verifications.map((value) => ({ ...scope, ...value })) as any[], options);
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
  const release = verifyOkfReleaseEnvelope(stored, ref);
  if (release.status !== 'ready') throw new OkfIntegrityError('not_ready', `OKF release '${ref.releaseId}' is ${release.status}`);
  return { release, activeRevocations: await loadActiveOkfRevocations(db, ref.tenantId, ref.environmentId, ref.releaseId, new Date(), session) };
}

export async function assertOkfReferenceReady(
  db: Db,
  ref: { releaseId: string; version: string; checksum: string },
  scope: { tenantId: string; environmentId: string },
  session?: any
): Promise<OkfReleaseEnvelope> {
  const loaded = await loadPinnedOkfRelease(db, { ...scope, ...ref }, session);
  return loaded.release;
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
  await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).insertOne(parsed as any);
  return parsed;
}

export async function loadActiveOkfRevocations(
  db: Db,
  tenantId: string,
  environmentId: string,
  releaseId?: string,
  now = new Date(),
  session?: any
): Promise<OkfRevocationEvent[]> {
  const events = await db.collection(COLLECTION_OKF_REVOCATION_EVENTS).find({
    tenantId,
    environmentId,
    ...(releaseId ? { $or: [{ releaseId }, { releaseId: { $exists: false } }] } : {}),
  }, session ? { session } : undefined).sort({ createdAt: 1 }).toArray();
  const latest = new Map<string, OkfRevocationEvent>();
  for (const raw of events) {
    const event = OkfRevocationEventSchema.parse(raw);
    latest.set(event.revocationId, event);
  }
  return [...latest.values()].filter((event) => event.eventType === 'created' && event.expiresAt > now);
}
