import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  EnvironmentId,
  FactSource,
} from '@journeyax/journey-core';
import { TurnApplicationService } from './kernel/turn-application.service';
import {
  connectToDatabase,
  COLLECTION_TOOL_EXECUTIONS,
  ToolExecutionRecord,
  DurableCutoverRecord,
  ReleaseActivationRecord,
  CutoverRepository,
  ReleaseActivationRepository,
  CutoverValidationError,
  ReleaseActivationValidationError,
  CutoverConflictError,
  ReleaseActivationConflictError,
  ReleaseActivationRepositoryUnavailableError,
} from '@journeyax/database';
import { hashToolInput } from './approval/approval.store';
import * as crypto from 'crypto';
import { computePackChecksum } from '@journeyax/business-pack';
import { isInCanaryBucket } from '@journeyax/journey-core';



@Injectable()
export class RuntimeService {
  public appService: TurnApplicationService;
  private inMemoryClaimedNonces = new Set<string>();
  private inMemoryActivationRecords = new Map<string, ReleaseActivationRecord>();
  private inMemoryCutoverRecords = this.inMemoryActivationRecords;
  private activationRepo: ReleaseActivationRepository | null = null;

  constructor(appService?: TurnApplicationService) {
    this.appService = appService || new TurnApplicationService();
  }

  public setAppServiceForTest(appService: TurnApplicationService): void {
    this.appService = appService;
  }

  public getReleaseActivationRepository(): ReleaseActivationRepository {
    if (!this.activationRepo) {
      this.activationRepo = new ReleaseActivationRepository(async () => {
        const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
        const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
        const { db, client } = await connectToDatabase(uri, dbName);
        return { db, client };
      });
    }
    return this.activationRepo;
  }

  /**
   * Backward-compatibility alias for getReleaseActivationRepository.
   * @deprecated Use getReleaseActivationRepository instead.
   */
  public getCutoverRepository(): ReleaseActivationRepository {
    return this.getReleaseActivationRepository();
  }

  public setReleaseActivationRepositoryForTest(repo: ReleaseActivationRepository): void {
    this.activationRepo = repo;
  }

  /**
   * Backward-compatibility alias for setReleaseActivationRepositoryForTest.
   * @deprecated Use setReleaseActivationRepositoryForTest instead.
   */
  public setCutoverRepositoryForTest(repo: ReleaseActivationRepository): void {
    this.setReleaseActivationRepositoryForTest(repo);
  }

  setReleaseActivationRecordForTest(record: ReleaseActivationRecord): void {
    const key = `${record.tenantId}:${record.environmentId}`;
    this.inMemoryActivationRecords.set(key, record);
  }

  /**
   * Backward-compatibility alias for setReleaseActivationRecordForTest.
   * @deprecated Use setReleaseActivationRecordForTest instead.
   */
  setCutoverRecordForTest(record: DurableCutoverRecord): void {
    this.setReleaseActivationRecordForTest(record);
  }

  /**
   * Retrieves the authoritative durable release activation record for a tenant and environment.
   *
   * GOVERNANCE:
   * 'tenant_cutovers' is the authoritative release activation record store.
   * Hardcoded in-memory registries are forbidden in production.
   * Any database/infrastructure failure fails closed with 503.
   */
  async getReleaseActivationRecord(
    tenantId: string,
    environmentId: string = 'production'
  ): Promise<ReleaseActivationRecord | null> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase();
    const key = `${normTenant}:${normEnv}`;

    if (process.env.MONGODB_URI) {
      try {
        return await this.getReleaseActivationRepository().getReleaseActivation(normTenant, normEnv);
      } catch (err: any) {
        if (err instanceof ReleaseActivationRepositoryUnavailableError) {
          throw new ServiceUnavailableException(`[ReleaseActivation] Database unavailable: ${err.message}`);
        }
        console.warn('[RuntimeService] Mongo release activation query failed; failing closed:', err.message);
        return null;
      }
    }

    // Only allow in-memory fallback in local test environments without MONGODB_URI
    if (process.env.NODE_ENV === 'production') {
      return null;
    }
    return this.inMemoryActivationRecords.get(key) || null;
  }

  /**
   * Backward-compatibility alias for getReleaseActivationRecord.
   * @deprecated Use getReleaseActivationRecord instead.
   */
  async getCutoverRecord(
    tenantId: string,
    environmentId: string = 'production'
  ): Promise<DurableCutoverRecord | null> {
    return this.getReleaseActivationRecord(tenantId, environmentId);
  }

  /**
   * Transactionally persists/updates a durable release activation record.
   * Delegates to ReleaseActivationRepository for strict release checksum validation, pointer check, CAS, and audit logging.
   */
  async persistReleaseActivationRecordTransactionally(
    tenantId: string,
    environmentId: EnvironmentId,
    activationData: {
      status: 'migrated' | 'canary' | 'unmigrated' | 'rollback';
      approvedReleaseVersion: string;
      approvedReleaseChecksum: string;
      expectedRevision?: number;
      canaryPercentage?: number;
      approvedBy: string;
      rollbackTargetVersion?: string;
      notes?: string;
    }
  ): Promise<ReleaseActivationRecord> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase() as EnvironmentId;

    if (!process.env.MONGODB_URI) {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Database unavailable: MONGODB_URI is not set');
      }
      // In-memory test fallback
      const key = `${normTenant}:${normEnv}`;
      const existing = this.inMemoryActivationRecords.get(key);
      if (activationData.expectedRevision !== undefined) {
        const currentRev = existing?.revision || 0;
        if (activationData.expectedRevision !== currentRev) {
          throw new ConflictException(
            `Release activation revision conflict (CAS mismatch): current revision is ${currentRev}, expected ${activationData.expectedRevision}`
          );
        }
      }
      const record: ReleaseActivationRecord = {
        tenantId: normTenant,
        environmentId: normEnv,
        status: activationData.status,
        approvedReleaseChecksum: activationData.approvedReleaseChecksum,
        approvedReleaseVersion: activationData.approvedReleaseVersion,
        canaryPercentage: activationData.canaryPercentage ?? 0,
        revision: (existing?.revision || 0) + 1,
        approvedBy: activationData.approvedBy,
        promotedAt: new Date(),
        rollbackTargetVersion: activationData.rollbackTargetVersion,
        notes: activationData.notes,
        updatedAt: new Date(),
      };
      this.inMemoryActivationRecords.set(key, record);
      return record;
    }

    try {
      return await this.getReleaseActivationRepository().promoteReleaseActivation(
        normTenant,
        normEnv,
        {
          status: activationData.status,
          approvedReleaseVersion: activationData.approvedReleaseVersion,
          approvedReleaseChecksum: activationData.approvedReleaseChecksum,
          expectedRevision: activationData.expectedRevision ?? 0,
          canaryPercentage: activationData.canaryPercentage,
          approvedBy: activationData.approvedBy,
          rollbackTargetVersion: activationData.rollbackTargetVersion,
          notes: activationData.notes,
        }
      );
    } catch (err: any) {
      if (err instanceof ReleaseActivationValidationError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof ReleaseActivationConflictError) {
        throw new ConflictException(err.message);
      }
      if (err instanceof ReleaseActivationRepositoryUnavailableError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
  }

  /**
   * Backward-compatibility alias for persistReleaseActivationRecordTransactionally.
   * @deprecated Use persistReleaseActivationRecordTransactionally instead.
   */
  async persistCutoverRecordTransactionally(
    tenantId: string,
    environmentId: EnvironmentId,
    cutoverData: {
      status: 'migrated' | 'canary' | 'unmigrated' | 'rollback';
      approvedReleaseVersion: string;
      approvedReleaseChecksum: string;
      expectedRevision?: number;
      canaryPercentage?: number;
      approvedBy: string;
      rollbackTargetVersion?: string;
      notes?: string;
    }
  ): Promise<DurableCutoverRecord> {
    return this.persistReleaseActivationRecordTransactionally(tenantId, environmentId, cutoverData);
  }

  clearClaimedNoncesForTest(): void {
    this.inMemoryClaimedNonces.clear();
  }

  /**
   * Authoritative server-side check if a tenant has an active published Business Pack.
   */
  async hasPack(
    tenantId: string,
    environmentId: EnvironmentId = 'production'
  ): Promise<boolean> {
    return this.appService.packRepo.hasActivePack(tenantId, environmentId);
  }

  /**
   * Loads workspace by ID
   */
  async getWorkspace(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string
  ): Promise<WorkspaceState | null> {
    return this.appService.workspaceRepo.load(tenantId, environmentId, workspaceId);
  }

  /**
   * Enforces the durable release activation record before any Business Pack is loaded or executed.
   *
   * Rules (all must hold — any failure throws ForbiddenException):
   *   1. A durable release activation record must exist for the tenant+environment.
   *   2. The record's tenantId must match the request tenant (cross-tenant binding).
   *   3. The record's status must be 'migrated', or 'canary' with this workspace in-bucket.
   *   4. A pack must be loadable from the active pointer.
   *   5. The record's approvedReleaseVersion must equal the active pack's version.
   *   6. The record's approvedReleaseChecksum must equal computePackChecksum(activePack).
   *
   * Missing record, wrong status (including 'rollback'), version/checksum mismatch,
   * stale pointer, or cross-tenant records are all rejected with HTTP 403 Forbidden.
   *
   * Returns the validated pack so the caller can pass it directly to executeTurn,
   * eliminating the double pack lookup.
   */
  async assertReleaseActivationApproved(
    tenantId: string,
    environmentId: string,
    stableKey?: string
  ): Promise<any> {
    const normTenant = (tenantId || '').trim().toLowerCase();
    const normEnv = (environmentId || 'production').trim().toLowerCase();

    // 1. Load the durable release activation record.
    let activation: ReleaseActivationRecord | null;
    try {
      activation = await this.getReleaseActivationRepository().getReleaseActivation(normTenant, normEnv);
    } catch (repoErr: any) {
      // Fail closed with 503 if the repository itself throws (e.g. connection error in prod)
      throw new ServiceUnavailableException(
        `[ReleaseActivationGate] Release activation record lookup failed for tenant='${normTenant}' env='${normEnv}': ${repoErr.message}`
      );
    }

    if (!activation) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] No approved release activation record found for tenant='${normTenant}' env='${normEnv}'. ` +
        `Execution requires a durable release activation entry with status 'migrated' or 'canary'.`
      );
    }

    // 2. Cross-tenant binding: the record must belong to this tenant
    if (activation.tenantId !== normTenant) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] Release activation record tenant mismatch: record.tenantId='${activation.tenantId}' ` +
        `does not match request tenant='${normTenant}'.`
      );
    }

    // 3. Status must be 'migrated' or 'canary' (with in-bucket routing for canary)
    if (activation.status === 'canary') {
      const canaryPct = activation.canaryPercentage ?? 0;
      const routingKey = stableKey || normTenant;
      if (!isInCanaryBucket(normTenant, normEnv, routingKey, canaryPct)) {
        throw new ForbiddenException(
          `[ReleaseActivationGate] Canary bucket assignment: tenant='${normTenant}' env='${normEnv}' ` +
          `key='${routingKey}' is NOT in the ${canaryPct}% canary bucket. ` +
          `Request must be served by legacy path for this workspace.`
        );
      }
    } else if (activation.status !== 'migrated') {
      const ALLOWED_STATUSES = ['migrated', 'canary'];
      throw new ForbiddenException(
        `[ReleaseActivationGate] Traffic policy status '${activation.status}' is not executable for tenant='${normTenant}' env='${normEnv}'. ` +
        `Allowed statuses: ${ALLOWED_STATUSES.join(', ')}.`
      );
    }

    // 4. Load the active pack — must exist
    let activePack: any;
    try {
      activePack = await this.appService.packRepo.loadActivePack(normTenant, normEnv as EnvironmentId);
    } catch (err: any) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] Active Business Pack unavailable for tenant='${normTenant}' env='${normEnv}': ${err.message}`
      );
    }

    if (!activePack) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] No active Business Pack found for tenant='${normTenant}' env='${normEnv}'.`
      );
    }

    // 5. Version agreement
    const activeVersion = activePack.manifest?.version;
    if (activation.approvedReleaseVersion !== activeVersion) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] Version mismatch for tenant='${normTenant}' env='${normEnv}': ` +
        `release activation approves v'${activation.approvedReleaseVersion}' but active pointer is v'${activeVersion}'. ` +
        `Pointer and release activation record must be in agreement.`
      );
    }

    // 6. Checksum agreement — compute from the live pack, compare to approved
    const liveChecksum = computePackChecksum(activePack);
    if (activation.approvedReleaseChecksum !== liveChecksum) {
      throw new ForbiddenException(
        `[ReleaseActivationGate] Checksum mismatch for tenant='${normTenant}' env='${normEnv}' v'${activeVersion}': ` +
        `release activation approved checksum '${activation.approvedReleaseChecksum}' does not match ` +
        `computed live checksum '${liveChecksum}'. Pack may have been tampered or pointer is stale.`
      );
    }

    // Return the validated pack so runTurn can pass it directly to executeTurn
    // without a second loadActivePack call.
    return activePack;
  }

  /**
   * Backward-compatibility alias for assertReleaseActivationApproved.
   * @deprecated Use assertReleaseActivationApproved instead.
   */
  async assertCutoverApproved(
    tenantId: string,
    environmentId: string,
    stableKey?: string
  ): Promise<any> {
    return this.assertReleaseActivationApproved(tenantId, environmentId, stableKey);
  }

  /**
   * Executes a turn in the canonical runtime engine.
   * Enforces the durable release activation gate, then passes the already-validated pack
   * directly to executeTurn — eliminating the double loadActivePack call.
   */
  async runTurn(command: TurnCommand): Promise<TurnResult> {
    const stableKey = command.workspaceId || command.sessionId || command.tenantId;
    const validatedPack = await this.assertReleaseActivationApproved(
      command.tenantId,
      command.environmentId || 'production',
      stableKey
    );
    return this.appService.executeTurn(command, validatedPack);
  }

  /**
   * Executes a turn over a genuine streaming event sink boundary.
   * Enforces the durable release activation gate, then passes the validated pack and event sink
   * directly to executeTurnStream.
   */
  async streamTurn(
    command: TurnCommand,
    sink: (event: string, data: any) => void
  ): Promise<TurnResult> {
    const stableKey = command.workspaceId || command.sessionId || command.tenantId;
    const validatedPack = await this.assertReleaseActivationApproved(
      command.tenantId,
      command.environmentId || 'production',
      stableKey
    );
    return this.appService.executeTurnStream(command, validatedPack, sink);
  }

  /**
   * Decides a pending tool execution approval.
   */
  async decideApproval(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string
  ): Promise<boolean> {
    return this.appService.approvalService.decide(
      tenantId,
      environmentId,
      workspaceId,
      approvalRequestId,
      decision,
      decidedBy,
      reason
    );
  }

  /**
   * Appends an externally verified fact to the workspace.
   */
  async appendFact(
    tenantId: string,
    environmentId: EnvironmentId,
    workspaceId: string,
    key: string,
    value: any,
    source: FactSource = 'external'
  ): Promise<{ success: boolean; workspaceId: string; key: string; stateVersion: number }> {
    const updated = await this.appService.workspaceRepo.appendFact(
      tenantId,
      environmentId,
      workspaceId,
      key,
      value,
      source
    );

    await this.appService.outboxRepo.enqueueEvent(
      tenantId,
      environmentId,
      'workspace.fact_appended',
      {
        workspaceId,
        key,
        value,
        source,
        stateVersion: updated.stateVersion,
      }
    );

    return {
      success: true,
      workspaceId,
      key,
      stateVersion: updated.stateVersion,
    };
  }

  /**
   * Process incoming webhook from Activepieces with HMAC verification, replay prevention, and idempotency.
   */
  async processActivepiecesWebhook(
    signatureHeader: string | undefined,
    timestampHeader: string | undefined,
    nonceHeader: string | undefined,
    payload: any,
    rawBody?: string
  ): Promise<{ status: string; nonce?: string; error?: string; result?: any }> {
    const secret = process.env.ACTIVEPIECES_WEBHOOK_SECRET;
    if (!secret) {
      return {
        status: 'rejected',
        error: 'Server security configuration error: ACTIVEPIECES_WEBHOOK_SECRET is not configured',
      };
    }

    if (!signatureHeader || !timestampHeader || !nonceHeader) {
      return {
        status: 'rejected',
        error: 'Missing security headers (x-activepieces-signature, x-activepieces-timestamp, x-activepieces-nonce)',
      };
    }

    const ts = parseInt(timestampHeader, 10);
    if (isNaN(ts)) {
      return { status: 'rejected', error: 'Invalid timestamp header' };
    }

    const now = Date.now();
    // 5 minutes max tolerance
    if (Math.abs(now - ts) > 5 * 60 * 1000) {
      return { status: 'rejected', error: 'Webhook timestamp expired or out of tolerance window' };
    }

    // Verify HMAC-SHA256 signature
    const stringBody = rawBody || JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${timestampHeader}.${nonceHeader}.${stringBody}`)
      .digest('hex');

    const sigBuf = Buffer.from(signatureHeader, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { status: 'rejected', error: 'Invalid HMAC signature' };
    }

    const tenantId = payload.tenantId || 'default';
    const environmentId: EnvironmentId = payload.environmentId || 'production';
    const workspaceId = payload.workspaceId;

    // 1. In-memory replay rejection (tenant-scoped)
    const nonceKey = `${tenantId}:${nonceHeader}`;
    if (this.inMemoryClaimedNonces.has(nonceKey)) {
      return {
        status: 'rejected',
        error: `Duplicate nonce detected: replay rejected (${nonceHeader})`,
        nonce: nonceHeader,
      };
    }

    // 2. Durable MongoDB replay rejection & Idempotency check via tool_executions
    if (process.env.MONGODB_URI) {
      try {
        const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx');
        const noncesCol = db.collection('webhook_nonces');
        // Atomic reservation: reject immediately if already claimed for this tenant
        try {
          await noncesCol.insertOne({
            tenantId,
            environmentId,
            nonce: nonceHeader,
            claimedAt: new Date(),
          });
        } catch (insertErr: any) {
          if (insertErr.code === 11000 || /duplicate key/i.test(insertErr.message)) {
            return {
              status: 'rejected',
              error: `Duplicate nonce detected: replay rejected (${nonceHeader})`,
              nonce: nonceHeader,
            };
          }
        }

        const executionsCol = db.collection<ToolExecutionRecord>(COLLECTION_TOOL_EXECUTIONS);
        const existing = await executionsCol.findOne({
          tenantId,
          toolId: 'activepieces.webhook',
          idempotencyKey: nonceHeader,
        });

        if (existing) {
          return {
            status: 'rejected',
            error: `Duplicate nonce detected: replay rejected (${nonceHeader})`,
            nonce: nonceHeader,
            result: existing.result,
          };
        }
      } catch (e: any) {
        console.warn('[RuntimeService] Mongo idempotency lookup warning:', e.message);
      }
    }

    let executionResult: any = null;

    if (payload.event === 'append_fact' || payload.event === 'external_result') {
      if (!workspaceId || !payload.data?.key) {
        return { status: 'rejected', error: 'Missing workspaceId or data.key for append_fact' };
      }
      executionResult = await this.appendFact(
        tenantId,
        environmentId,
        workspaceId,
        payload.data.key,
        payload.data.value,
        (payload.data.source || 'external') as FactSource
      );
    } else if (payload.event === 'resolve_approval') {
      if (!workspaceId || !payload.data?.approvalRequestId || !payload.data?.decision) {
        return { status: 'rejected', error: 'Missing workspaceId, approvalRequestId or decision' };
      }
      const success = await this.decideApproval(
        tenantId,
        environmentId,
        workspaceId,
        payload.data.approvalRequestId,
        payload.data.decision,
        payload.data.decidedBy || 'activepieces'
      );
      executionResult = { success, approvalRequestId: payload.data.approvalRequestId };
    } else {
      executionResult = { received: true, event: payload.event };
    }

    // Record claimed nonce in-memory
    this.inMemoryClaimedNonces.add(nonceKey);

    // Record execution for idempotency
    if (process.env.MONGODB_URI) {
      try {
        const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx');
        const executionsCol = db.collection<ToolExecutionRecord>(COLLECTION_TOOL_EXECUTIONS);
        await executionsCol.insertOne({
          tenantId,
          environmentId,
          workspaceId: workspaceId || 'system',
          toolId: 'activepieces.webhook',
          idempotencyKey: nonceHeader,
          inputHash: hashToolInput(payload),
          status: 'completed',
          result: executionResult,
          startedAt: new Date(ts),
          completedAt: new Date(),
        });
      } catch (e: any) {
        console.warn('[RuntimeService] Failed to record webhook execution:', e.message);
      }
    }

    return {
      status: 'processed',
      nonce: nonceHeader,
      result: executionResult,
    };
  }

  // Webhook Subscriptions Management
  private inMemorySubscriptions = new Map<string, WebhookSubscriptionRecord>();

  async registerWebhookSubscription(
    tenantId: string,
    environmentId: string,
    event: string,
    webhookUrl: string
  ): Promise<WebhookSubscriptionRecord> {
    const subscriptionId = `sub_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
    const record: WebhookSubscriptionRecord = {
      subscriptionId,
      tenantId,
      environmentId,
      event,
      webhookUrl,
      status: 'active',
      createdAt: new Date().toISOString(),
    };

    this.inMemorySubscriptions.set(`${tenantId}:${environmentId}:${subscriptionId}`, record);

    if (process.env.MONGODB_URI) {
      try {
        const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx');
        await db.collection('webhook_subscriptions').insertOne({
          ...record,
          createdAt: new Date(record.createdAt),
        });
      } catch (err: any) {
        console.warn('[RuntimeService] Mongo webhook subscription insert warning:', err.message);
      }
    }

    return record;
  }

  async unregisterWebhookSubscription(
    tenantId: string,
    environmentId: string,
    subscriptionId: string
  ): Promise<boolean> {
    const key = `${tenantId}:${environmentId}:${subscriptionId}`;
    const existed = this.inMemorySubscriptions.delete(key);

    if (process.env.MONGODB_URI) {
      try {
        const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx');
        await db.collection('webhook_subscriptions').deleteOne({
          tenantId,
          environmentId,
          subscriptionId,
        });
      } catch (err: any) {
        console.warn('[RuntimeService] Mongo webhook subscription delete warning:', err.message);
      }
    }

    return existed;
  }

  async listWebhookSubscriptions(
    tenantId: string,
    environmentId: string,
    event?: string
  ): Promise<WebhookSubscriptionRecord[]> {
    const results: WebhookSubscriptionRecord[] = [];
    for (const sub of this.inMemorySubscriptions.values()) {
      if (sub.tenantId === tenantId && sub.environmentId === environmentId) {
        if (!event || sub.event === event || sub.event === '*') {
          results.push(sub);
        }
      }
    }

    if (results.length === 0 && process.env.MONGODB_URI) {
      try {
        const { db } = await connectToDatabase(process.env.MONGODB_URI, process.env.MONGODB_DB_NAME || 'journeyx');
        const query: any = { tenantId, environmentId };
        if (event && event !== '*') {
          query.event = { $in: [event, '*'] };
        }
        const docs = await db.collection('webhook_subscriptions').find(query).toArray();
        for (const doc of docs) {
          results.push({
            subscriptionId: doc.subscriptionId,
            tenantId: doc.tenantId,
            environmentId: doc.environmentId,
            event: doc.event,
            webhookUrl: doc.webhookUrl,
            status: doc.status || 'active',
            createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
          });
        }
      } catch (err: any) {
        console.warn('[RuntimeService] Mongo webhook subscription list warning:', err.message);
      }
    }

    return results;
  }

  /**
   * Replays a failed dead-letter outbox event.
   */
  async replayDeadLetterEvent(eventId: string): Promise<boolean> {
    return this.appService.outboxRepo.replayDeadLetter(eventId);
  }

  /**
   * Resolves a dead-letter outbox event with an operational audit note.
   */
  async resolveDeadLetterEvent(eventId: string, resolutionNote: string): Promise<boolean> {
    return this.appService.outboxRepo.resolveDeadLetter(eventId, resolutionNote);
  }

  /**
   * Retrieves operational metrics for the transactional outbox.
   */
  async getOutboxMetrics(tenantId?: string): Promise<{ pending: number; leased: number; published: number; deadLetter: number }> {
    return this.appService.outboxRepo.getMetrics(tenantId);
  }
}

export interface WebhookSubscriptionRecord {
  subscriptionId: string;
  tenantId: string;
  environmentId: string;
  event: string;
  webhookUrl: string;
  status: 'active' | 'disabled';
  createdAt: string;
}
