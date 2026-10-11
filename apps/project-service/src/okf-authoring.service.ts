import { Injectable, Logger } from '@nestjs/common';
import { can } from '@journeyax/shared-types';
import {
  COLLECTION_OKF_RELEASES,
  COLLECTION_OKF_EVALUATION_REPORTS,
  COLLECTION_OKF_ARTIFACT_POLICIES,
  archiveOkfBundle,
  OkfDraftContentSchema,
  buildServerOwnedOkfContent,
  evaluateOkfDraft,
  assertOkfReferenceReady,
  createOkfRevocation,
  liftOkfRevocation,
  listOkfRevocations,
  pruneOkfRevocationEvents,
  OkfIntegrityError,
  computeKnowledgeChecksum,
  exportOkfBundle,
  hydrateOkfReleaseEnvelope,
  importOkfBundle,
  publishOkfRelease,
  resolveOkfGate,
  validateOkfDraftContent,
  validateOkfReleaseContent,
  type OkfReleaseContent,
} from '@journeyax/knowledge';

export const COLLECTION_OKF_DRAFTS = 'okf_drafts';
export const COLLECTION_OKF_VERIFICATION_ATTESTATIONS = 'okf_verification_attestations';
export const COLLECTION_OKF_VERIFIER_ROLES = 'okf_verifier_roles';

export class OkfDraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfDraftConflictError';
  }
}

type DbProvider = () => any;
type AttachedFactRegistry = {
  version: string;
  facts: Record<string, {
    description: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'enum';
    allowedValues?: string[];
    uiInputType: string;
    promptQuestion: string;
    metadata: { questionRef: string };
  }>;
};
type AttachRelease = (
  projectId: string,
  update: {
    knowledgeModel: { type: 'okf_release'; modelId: string; releaseId: string; version: string; checksum: string; required: boolean; failurePolicy: 'fail_closed' | 'enrichment_only' };
    factRegistry: AttachedFactRegistry;
  }
) => Promise<{ success: boolean; message?: string }>;

@Injectable()
export class OkfAuthoringService {
  private readonly logger = new Logger(OkfAuthoringService.name);

  constructor(
    private readonly dbProvider: DbProvider,
    private readonly attachRelease: AttachRelease
  ) {}

  private async attachToProjectDraft(projectId: string, content: OkfReleaseContent, ref: Parameters<AttachRelease>[1]['knowledgeModel']) {
    const result = await this.attachRelease(projectId, {
      knowledgeModel: ref,
      factRegistry: this.attachedFactRegistry(content),
    });
    if (result?.success !== true) {
      throw new Error(`OKF release attachment failed: ${result?.message || 'project draft was not updated'}`);
    }
  }

  private scope(projectId: string, environmentId: string) {
    const tenantId = (projectId || '').trim().toLowerCase();
    const environment = (environmentId || 'production').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error('A valid projectId is required');
    if (!['dev', 'test', 'staging', 'production'].includes(environment)) throw new Error('Invalid environmentId');
    return { tenantId, environmentId: environment };
  }

  /**
   * The OKF fact registry is part of the same immutable authoring unit as the
   * knowledge graph. Copying it onto the Business Pack draft makes those facts
   * available to the canonical interpreter without a second per-turn OKF read.
   */
  private attachedFactRegistry(content: OkfReleaseContent): AttachedFactRegistry {
    return {
      version: content.schemaVersion,
      facts: Object.fromEntries(content.factRegistry.map((fact) => [fact.factKey, {
        description: fact.question,
        type: fact.type,
        ...(fact.allowedValues || fact.options?.map((option) => option.value)
          ? { allowedValues: fact.allowedValues || fact.options?.map((option) => option.value) }
          : {}),
        uiInputType: fact.uiInputType,
        promptQuestion: fact.question,
        metadata: { questionRef: fact.questionRef },
      }])),
    };
  }

  async getDraft(projectId: string, environmentId = 'production'): Promise<any | null> {
    const db = await this.dbProvider();
    return db.collection(COLLECTION_OKF_DRAFTS).findOne(this.scope(projectId, environmentId));
  }

  async saveDraft(input: {
    projectId: string;
    environmentId?: string;
    expectedRevision: number;
    content: unknown;
    updatedBy: string;
  }): Promise<any> {
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer');
    }
    // Older back offices may still submit these fields; they are never trusted
    // or persisted on an editable draft.
    const { index: _clientIndex, evaluation: _clientEvaluation, ...editable } =
      (input.content && typeof input.content === 'object' && !Array.isArray(input.content))
        ? input.content as Record<string, unknown>
        : {};
    const parsed = OkfDraftContentSchema.safeParse(editable);
    if (!parsed.success) throw new Error(`Invalid OKF draft structure: ${parsed.error.message}`);
    const db = await this.dbProvider();
    const collection = db.collection(COLLECTION_OKF_DRAFTS);
    const existing = await collection.findOne(scope);
    const currentRevision = existing?.revision || 0;
    if (currentRevision !== input.expectedRevision) {
      throw new OkfDraftConflictError(`OKF draft revision conflict: current=${currentRevision}, expected=${input.expectedRevision}`);
    }

    const validation = validateOkfDraftContent(parsed.data, scope.tenantId);
    const now = new Date();
    const previousHistory = Array.isArray(existing?.authorHistory)
      ? existing.authorHistory
      : existing?.revision === 1 && existing.updatedBy
      ? [{ revision: 1, authorId: existing.updatedBy, at: existing.updatedAt || existing.createdAt }]
      : [];
    const historyComplete = !existing || (
      previousHistory.length === currentRevision &&
      previousHistory.every((entry: any, index: number) =>
        entry?.revision === index + 1 && typeof entry?.authorId === 'string' && Boolean(entry.authorId)) &&
      (existing.authorHistoryComplete === true || currentRevision === 1)
    );
    const next = {
      ...scope,
      revision: currentRevision + 1,
      authorIds: [...new Set([...(existing?.authorIds || (existing?.updatedBy ? [existing.updatedBy] : [])), input.updatedBy])],
      authorHistory: [...previousHistory, { revision: currentRevision + 1, authorId: input.updatedBy, at: now }],
      authorHistoryComplete: historyComplete,
      checksum: computeKnowledgeChecksum(parsed.data),
      content: parsed.data,
      validation: { valid: validation.valid, issues: validation.issues },
      updatedAt: now,
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt || now,
    };

    if (existing) {
      const result = await collection.replaceOne({ ...scope, revision: currentRevision }, next);
      if (result.matchedCount !== 1) throw new OkfDraftConflictError('OKF draft changed during save');
    } else {
      try {
        await collection.insertOne(next);
      } catch (error: any) {
        if (error?.code === 11000) throw new OkfDraftConflictError('OKF draft was created concurrently');
        throw error;
      }
    }
    return next;
  }

  /** Imports an untrusted bundle as a draft; publication still requires validation and human attestations. */
  async importBundle(input: {
    projectId: string;
    environmentId?: string;
    expectedRevision: number;
    archive: Uint8Array;
    updatedBy: string;
  }) {
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    const imported = importOkfBundle(input.archive, scope.tenantId);
    const draft = await this.saveDraft({
      projectId: scope.tenantId,
      environmentId: scope.environmentId,
      expectedRevision: input.expectedRevision,
      content: imported.draft,
      updatedBy: input.updatedBy,
    });
    return { draft, declaredVersion: imported.declaredVersion, diagnostics: imported.diagnostics };
  }

  async getArtifactPolicy(projectId: string, environmentId = 'production') {
    const scope = this.scope(projectId, environmentId);
    const stored = await (await this.dbProvider()).collection(COLLECTION_OKF_ARTIFACT_POLICIES).findOne(scope);
    return { ...scope, artifactRequired: stored?.artifactRequired === true };
  }

  /** Explicit tenant/environment verifier assignments; draft JSON cannot grant these. */
  async configureVerifierRole(projectId: string, environmentId: string, roleId: string, principalIds: string[], updatedBy: string) {
    const scope = this.scope(projectId, environmentId);
    if (!/^[a-z][a-z0-9_]*$/.test(roleId)) throw new Error('Invalid verifier role ID');
    if (!Array.isArray(principalIds) || principalIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error('Verifier principal IDs must be non-empty strings');
    }
    const members = [...new Set(principalIds.map((id) => id.trim()))];
    await (await this.dbProvider()).collection(COLLECTION_OKF_VERIFIER_ROLES).updateOne(
      { ...scope, roleId },
      { $set: { ...scope, roleId, permission: 'knowledge.verify', principalIds: members, status: 'active', updatedBy, updatedAt: new Date() } },
      { upsert: true },
    );
    return { ...scope, roleId, principalIds: members, status: 'active' };
  }

  async setArtifactPolicy(projectId: string, environmentId: string, artifactRequired: boolean, updatedBy: string) {
    if (typeof artifactRequired !== 'boolean') throw new Error('artifactRequired must be a boolean');
    const scope = this.scope(projectId, environmentId);
    await (await this.dbProvider()).collection(COLLECTION_OKF_ARTIFACT_POLICIES).updateOne(scope, {
      $set: { ...scope, artifactRequired, updatedBy, updatedAt: new Date() },
    }, { upsert: true });
    return { ...scope, artifactRequired };
  }

  async validateDraft(projectId: string, environmentId = 'production') {
    const draft = await this.getDraft(projectId, environmentId);
    if (!draft) throw new Error('OKF draft not found');
    return validateOkfDraftContent(draft.content, this.scope(projectId, environmentId).tenantId);
  }

  private verificationAttestationHash(record: any): string {
    return computeKnowledgeChecksum({
      recordId: record.recordId,
      targetType: record.targetType,
      targetId: record.targetId,
      status: record.status,
      contentHash: record.contentHash,
      sourceRefs: [...(record.sourceRefs || [])].sort(),
      verifiedBy: record.verifiedBy,
      verifierRole: record.verifierRole,
    });
  }

  /**
   * Server-side approval record for a verified claim. The attestation is stored
   * outside author-controlled OKF JSON and is bound to the exact target hash and
   * source set. A draft author cannot approve their own verification record.
   */
  async attestDraftVerification(input: {
    projectId: string;
    environmentId?: string;
    expectedRevision: number;
    recordId: string;
    approvedBy: string;
    approverRole: string;
  }) {
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    const draft = await this.getDraft(input.projectId, input.environmentId || 'production');
    if (!draft) throw new Error('OKF draft not found');
    if (draft.revision !== input.expectedRevision) {
      throw new OkfDraftConflictError(`OKF draft revision conflict: current=${draft.revision}, expected=${input.expectedRevision}`);
    }
    if (draft.revision > 1 && draft.authorHistoryComplete !== true) {
      throw new Error('Draft author history is incomplete; verification requires a fully attributed draft');
    }
    if (!input.approvedBy || (draft.authorIds || [draft.updatedBy]).includes(input.approvedBy)) {
      throw new Error('Verified knowledge requires approval by a different authenticated user than the draft author');
    }
    const record = draft.content.verifications.find((candidate: any) => candidate.recordId === input.recordId);
    if (!record) throw new Error(`Verification record '${input.recordId}' not found`);
    if (record.status !== 'verified') throw new Error(`Verification record '${input.recordId}' is not marked verified`);
    if (record.verifiedBy !== input.approvedBy) throw new Error(`Verification record '${input.recordId}' verifiedBy must equal the authenticated approver`);
    if (!can(input.approverRole, 'knowledge.verify')) throw new Error('Approver lacks knowledge.verify permission');
    const registry = await (await this.dbProvider()).collection(COLLECTION_OKF_VERIFIER_ROLES).findOne({
      ...scope, roleId: record.verifierRole, status: 'active', permission: 'knowledge.verify',
    });
    if (!registry || !Array.isArray(registry.principalIds) || !registry.principalIds.includes(input.approvedBy)) {
      throw new Error(`Approver is not assigned tenant verifier role '${record.verifierRole}'`);
    }

    const attestation = {
      ...scope,
      recordId: record.recordId,
      targetType: record.targetType,
      targetId: record.targetId,
      contentHash: record.contentHash,
      attestationHash: this.verificationAttestationHash(record),
      draftRevision: draft.revision,
      approvedBy: input.approvedBy,
      approverRole: input.approverRole,
      domainRole: record.verifierRole,
      approvedAt: new Date(),
    };
    await (await this.dbProvider()).collection(COLLECTION_OKF_VERIFICATION_ATTESTATIONS).insertOne(attestation);
    return attestation;
  }

  private async assertVerificationAttestations(scope: { tenantId: string; environmentId: string }, content: OkfReleaseContent) {
    const collection = (await this.dbProvider()).collection(COLLECTION_OKF_VERIFICATION_ATTESTATIONS);
    for (const record of content.verifications.filter((candidate) => candidate.status === 'verified')) {
      const attestationHash = this.verificationAttestationHash(record);
      const attestation = await collection.findOne({ ...scope, recordId: record.recordId, attestationHash });
      if (!attestation) {
        throw new Error(`OKF publication blocked: verified record '${record.recordId}' lacks a matching server-side attestation`);
      }
      if (attestation.approvedBy !== record.verifiedBy || attestation.domainRole !== record.verifierRole) {
        throw new Error(`OKF publication blocked: verified record '${record.recordId}' attestation identity or role mismatch`);
      }
      const registry = await (await this.dbProvider()).collection(COLLECTION_OKF_VERIFIER_ROLES).findOne({
        ...scope, roleId: record.verifierRole, status: 'active', permission: 'knowledge.verify',
      });
      if (!registry?.principalIds?.includes(attestation.approvedBy)) {
        throw new Error(`OKF publication blocked: verifier role '${record.verifierRole}' is no longer assigned`);
      }
    }
  }

  async previewDraft(
    projectId: string,
    input: { message: string; knownFacts?: Record<string, unknown>; intentCandidates?: string[]; forceShowResults?: boolean },
    environmentId = 'production'
  ) {
    const draft = await this.getDraft(projectId, environmentId);
    if (!draft) throw new Error('OKF draft not found');
    const validation = validateOkfDraftContent(draft.content, this.scope(projectId, environmentId).tenantId);
    if (!validation.valid) {
      return { previewable: false, validation: { valid: false, issues: validation.issues } };
    }
    return {
      previewable: true,
      revision: draft.revision,
      checksum: draft.checksum,
      decision: resolveOkfGate(draft.content as OkfReleaseContent, {
        tenantId: this.scope(projectId, environmentId).tenantId,
        environmentId,
        releaseId: `draft:${this.scope(projectId, environmentId).tenantId}:${draft.revision}`,
        message: input.message || '',
        knownFacts: input.knownFacts || {},
        intentCandidates: input.intentCandidates || [],
        forceShowResults: Boolean(input.forceShowResults),
        knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' },
      }),
    };
  }

  async publishDraft(input: {
    projectId: string;
    environmentId?: 'dev' | 'test' | 'staging' | 'production';
    expectedRevision: number;
    version: string;
    releaseId?: string;
    publishedBy: string;
    required?: boolean;
    failurePolicy?: 'fail_closed' | 'enrichment_only';
    notes?: string;
  }) {
    const environmentId = input.environmentId || 'production';
    const scope = this.scope(input.projectId, environmentId);
    const draft = await this.getDraft(input.projectId, environmentId);
    if (!draft) throw new Error('OKF draft not found');
    if (draft.revision !== input.expectedRevision) {
      throw new OkfDraftConflictError(`OKF draft revision conflict: current=${draft.revision}, expected=${input.expectedRevision}`);
    }
    if (draft.revision > 1 && draft.authorHistoryComplete !== true) {
      throw new Error('OKF publication blocked: draft author history is incomplete');
    }
    const releaseId = input.releaseId || `okf-${scope.tenantId}-${environmentId}-${input.version}`;
    const db = await this.dbProvider();
    const existing = await db.collection(COLLECTION_OKF_RELEASES).findOne({ ...scope, releaseId });
    if (existing) {
      const report = await db.collection(COLLECTION_OKF_EVALUATION_REPORTS).findOne({
        ...scope, releaseId, sourceDraftChecksum: draft.checksum,
      });
      if (!report) throw new Error('OKF publication blocked: release ID is already bound to a different draft');
      const release = await hydrateOkfReleaseEnvelope(db, existing);
      if (release.status !== 'ready' || release.version !== input.version ||
        report.releaseChecksum !== release.checksum ||
        report.reportId !== release.content.evaluation.reportId ||
        report.evaluatedAt !== release.content.evaluation.evaluatedAt ||
        !Array.isArray(report.scenarios) ||
        `eval-${computeKnowledgeChecksum(report.scenarios)}` !== report.reportId) {
        throw new Error('OKF publication blocked: existing release or evaluation report failed integrity checks');
      }
      const required = input.required ?? true;
      const ref = {
        type: 'okf_release' as const,
        modelId: release.content.modelId,
        releaseId: release.releaseId,
        version: release.version,
        checksum: release.checksum,
        required,
        failurePolicy: required ? 'fail_closed' as const : (input.failurePolicy || 'enrichment_only'),
      };
      await this.attachToProjectDraft(scope.tenantId, release.content, ref);
      return { release, knowledgeModel: ref, nextStep: 'publish_business_pack' };
    }
    const validation = validateOkfDraftContent(draft.content, scope.tenantId);
    if (!validation.valid) throw new Error(`OKF publication blocked: ${validation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; ')}`);
    if (draft.content.verifications.some((record: any) => record.status === 'verified' &&
      (draft.authorIds || [draft.updatedBy]).includes(record.verifiedBy))) {
      throw new Error('OKF publication blocked: a verified record is approved by a draft author');
    }
    const publicationTime = Date.now();
    if (draft.content.verifications.some((record: any) => record.status === 'verified' &&
      record.staleAfter && new Date(record.staleAfter).getTime() <= publicationTime)) {
      throw new Error('OKF publication blocked: verified knowledge is stale and requires review');
    }
    if (draft.content.sources.some((source: any) => source.kind === 'regulation' &&
      source.supersededAt && new Date(source.supersededAt).getTime() <= publicationTime)) {
      throw new Error('OKF publication blocked: a regulatory source has been superseded');
    }
    await this.assertVerificationAttestations(scope, draft.content);
    const content = buildServerOwnedOkfContent(draft.content, {
      ...scope,
      releaseId,
      evaluatedAt: new Date().toISOString(),
    });
    const evaluationScenarios = evaluateOkfDraft(draft.content, scope.tenantId, environmentId, releaseId, content.evaluation.evaluatedAt);
    const releaseValidation = validateOkfReleaseContent(content, scope.tenantId);
    if (!releaseValidation.valid) throw new Error(`OKF publication blocked: ${releaseValidation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; ')}`);
    const release = await publishOkfRelease(db, {
      releaseId,
      tenantId: scope.tenantId,
      environmentId: environmentId as any,
      version: input.version,
      content,
      evaluationScenarios,
      sourceDraftChecksum: draft.checksum,
      publishedBy: input.publishedBy,
      notes: input.notes,
    });
    const required = input.required ?? true;
    const failurePolicy = required ? 'fail_closed' : (input.failurePolicy || 'enrichment_only');
    const ref = {
      type: 'okf_release' as const,
      modelId: release.content.modelId,
      releaseId: release.releaseId,
      version: release.version,
      checksum: release.checksum,
      required,
      failurePolicy: failurePolicy as 'fail_closed' | 'enrichment_only',
    };
    await this.attachToProjectDraft(scope.tenantId, release.content, ref);
    return { release, knowledgeModel: ref, nextStep: 'publish_business_pack' };
  }

  private requireActor(actor: string | undefined, action: string): string {
    const principal = (actor || '').trim();
    if (!principal) throw new Error(`${action} requires an authenticated principal`);
    return principal;
  }

  /** Withdraws guidance from a published release at once; expiry is mandatory and explicit. */
  async createRevocation(input: {
    projectId: string;
    environmentId?: string;
    releaseId: string;
    conceptIds: string[];
    cascade?: 'none' | 'descendants';
    effect?: { suppressClaims?: boolean; suppressRetrieval?: boolean };
    reason: string;
    expiresAt: string | Date;
    actor?: string;
  }) {
    const actor = this.requireActor(input.actor, 'Creating a revocation');
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new Error('expiresAt must be a valid date');
    const reason = (input.reason || '').trim();
    if (!reason) throw new Error('A revocation reason is required');
    const event = await createOkfRevocation(await this.dbProvider(), {
      ...scope,
      releaseId: input.releaseId,
      conceptIds: input.conceptIds,
      cascade: input.cascade || 'descendants',
      effect: { suppressClaims: input.effect?.suppressClaims ?? true, suppressRetrieval: input.effect?.suppressRetrieval ?? true },
      reason,
      createdBy: actor,
      expiresAt,
    });
    this.logger.warn(JSON.stringify({ event: 'okf.revocation.created', ...scope, revocationId: event.revocationId, releaseId: event.releaseId, concepts: event.conceptIds.length, actor, expiresAt: event.expiresAt }));
    return event;
  }

  async liftRevocation(input: {
    projectId: string;
    environmentId?: string;
    revocationId: string;
    correctedReleaseId: string;
    reason?: string;
    actor?: string;
  }) {
    const actor = this.requireActor(input.actor, 'Lifting a revocation');
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    const event = await liftOkfRevocation(await this.dbProvider(), {
      ...scope, revocationId: input.revocationId, correctedReleaseId: input.correctedReleaseId,
      liftedBy: actor, reason: (input.reason || '').trim(),
    });
    this.logger.warn(JSON.stringify({ event: 'okf.revocation.lifted', ...scope, revocationId: event.revocationId, correctedReleaseId: event.correctedReleaseId, actor }));
    return event;
  }

  async listRevocations(projectId: string, environmentId = 'production') {
    return listOkfRevocations(await this.dbProvider(), this.scope(projectId, environmentId));
  }

  async pruneRevocations(projectId: string, environmentId: string, before: string | Date, actor?: string) {
    const principal = this.requireActor(actor, 'Pruning revocation history');
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) throw new Error('before must be a valid date');
    const result = await pruneOkfRevocationEvents(await this.dbProvider(), { ...this.scope(projectId, environmentId), before: cutoff });
    this.logger.log(JSON.stringify({ event: 'okf.revocation.pruned', ...this.scope(projectId, environmentId), archived: result.archived, actor: principal }));
    return result;
  }

  async listReleases(projectId: string, environmentId = 'production') {
    const scope = this.scope(projectId, environmentId);
    const db = await this.dbProvider();
    const rows = await db.collection(COLLECTION_OKF_RELEASES)
      .find(scope, { projection: { content: 0 } })
      .sort({ publishedAt: -1 })
      .limit(100)
      .toArray();
    return rows;
  }

  /** Export is reconstructed from the pinned Mongo release, never from live GCS. */
  async exportRelease(projectId: string, releaseId: string, environmentId = 'production'): Promise<Uint8Array> {
    const scope = this.scope(projectId, environmentId);
    const stored = await (await this.dbProvider()).collection(COLLECTION_OKF_RELEASES).findOne({ ...scope, releaseId });
    if (!stored) throw new Error('OKF release not found');
    const release = await hydrateOkfReleaseEnvelope(await this.dbProvider(), stored);
    if (release.tenantId !== scope.tenantId || release.environmentId !== scope.environmentId || release.releaseId !== releaseId) {
      throw new Error('OKF release scope mismatch');
    }
    return archiveOkfBundle(exportOkfBundle(release));
  }

  async selectRelease(input: {
    projectId: string;
    environmentId?: string;
    releaseId: string;
    version: string;
    checksum: string;
    required?: boolean;
    failurePolicy?: 'fail_closed' | 'enrichment_only';
  }) {
    const scope = this.scope(input.projectId, input.environmentId || 'production');
    const release = await assertOkfReferenceReady(await this.dbProvider(), {
      releaseId: input.releaseId,
      version: input.version,
      checksum: input.checksum,
    }, scope);
    const required = input.required ?? true;
    const ref = {
      type: 'okf_release' as const,
      modelId: release.content.modelId,
      releaseId: input.releaseId,
      version: input.version,
      checksum: input.checksum,
      required,
      failurePolicy: required ? 'fail_closed' as const : (input.failurePolicy || 'enrichment_only'),
    };
    await this.attachToProjectDraft(scope.tenantId, release.content, ref);
    return { knowledgeModel: ref, nextStep: 'publish_business_pack' };
  }
}
