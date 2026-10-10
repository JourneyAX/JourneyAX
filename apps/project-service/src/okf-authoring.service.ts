import { Injectable } from '@nestjs/common';
import {
  COLLECTION_OKF_RELEASES,
  OkfReleaseContentSchema,
  assertOkfReferenceReady,
  computeKnowledgeChecksum,
  publishOkfRelease,
  resolveOkfGate,
  validateOkfReleaseContent,
  type OkfReleaseContent,
} from '@journeyax/knowledge';

export const COLLECTION_OKF_DRAFTS = 'okf_drafts';

export class OkfDraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfDraftConflictError';
  }
}

type DbProvider = () => any;
type AttachRelease = (
  projectId: string,
  ref: { type: 'okf_release'; releaseId: string; version: string; checksum: string; required: boolean; failurePolicy: 'fail_closed' | 'enrichment_only' }
) => Promise<any>;

@Injectable()
export class OkfAuthoringService {
  constructor(
    private readonly dbProvider: DbProvider,
    private readonly attachRelease: AttachRelease
  ) {}

  private scope(projectId: string, environmentId: string) {
    const tenantId = (projectId || '').trim().toLowerCase();
    const environment = (environmentId || 'production').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error('A valid projectId is required');
    if (!['dev', 'test', 'staging', 'production'].includes(environment)) throw new Error('Invalid environmentId');
    return { tenantId, environmentId: environment };
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
    const parsed = OkfReleaseContentSchema.safeParse(input.content);
    if (!parsed.success) throw new Error(`Invalid OKF draft structure: ${parsed.error.message}`);
    const db = await this.dbProvider();
    const collection = db.collection(COLLECTION_OKF_DRAFTS);
    const existing = await collection.findOne(scope);
    const currentRevision = existing?.revision || 0;
    if (currentRevision !== input.expectedRevision) {
      throw new OkfDraftConflictError(`OKF draft revision conflict: current=${currentRevision}, expected=${input.expectedRevision}`);
    }

    const validation = validateOkfReleaseContent(parsed.data, scope.tenantId);
    const now = new Date();
    const next = {
      ...scope,
      revision: currentRevision + 1,
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

  async validateDraft(projectId: string, environmentId = 'production') {
    const draft = await this.getDraft(projectId, environmentId);
    if (!draft) throw new Error('OKF draft not found');
    return validateOkfReleaseContent(draft.content, this.scope(projectId, environmentId).tenantId);
  }

  async previewDraft(
    projectId: string,
    input: { message: string; knownFacts?: Record<string, unknown>; intentCandidates?: string[]; forceShowResults?: boolean },
    environmentId = 'production'
  ) {
    const draft = await this.getDraft(projectId, environmentId);
    if (!draft) throw new Error('OKF draft not found');
    const validation = validateOkfReleaseContent(draft.content, this.scope(projectId, environmentId).tenantId);
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
    const validation = validateOkfReleaseContent(draft.content, scope.tenantId);
    if (!validation.valid) throw new Error(`OKF publication blocked: ${validation.issues.map((issue) => `${issue.code}:${issue.message}`).join('; ')}`);
    const releaseId = input.releaseId || `okf-${scope.tenantId}-${environmentId}-${input.version}`;
    const release = await publishOkfRelease(await this.dbProvider(), {
      releaseId,
      tenantId: scope.tenantId,
      environmentId: environmentId as any,
      version: input.version,
      content: draft.content,
      publishedBy: input.publishedBy,
      notes: input.notes,
    });
    const required = input.required ?? true;
    const failurePolicy = required ? 'fail_closed' : (input.failurePolicy || 'enrichment_only');
    const ref = {
      type: 'okf_release' as const,
      releaseId: release.releaseId,
      version: release.version,
      checksum: release.checksum,
      required,
      failurePolicy: failurePolicy as 'fail_closed' | 'enrichment_only',
    };
    await this.attachRelease(scope.tenantId, ref);
    return { release, knowledgeModel: ref, nextStep: 'publish_business_pack' };
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
    await assertOkfReferenceReady(await this.dbProvider(), {
      releaseId: input.releaseId,
      version: input.version,
      checksum: input.checksum,
    }, scope);
    const required = input.required ?? true;
    const ref = {
      type: 'okf_release' as const,
      releaseId: input.releaseId,
      version: input.version,
      checksum: input.checksum,
      required,
      failurePolicy: required ? 'fail_closed' as const : (input.failurePolicy || 'enrichment_only'),
    };
    await this.attachRelease(scope.tenantId, ref);
    return { knowledgeModel: ref, nextStep: 'publish_business_pack' };
  }
}
