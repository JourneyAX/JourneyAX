import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import {
  connectToDatabase,
  OutboxRepository as DbOutboxRepository,
  NotificationDispatcher,
  COLLECTION_TOOL_APPROVALS,
  ToolApprovalRecord,
  COLLECTION_ANALYTICS_EVENTS,
  AnalyticsEventRecord,
  AnalyticsCategory,
  EnvironmentId,
} from '@journeyax/database';
import {
  CapabilityDispatcher,
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
  ExecutionRequest,
} from '@journeyax/capability-sdk';
import { computePackChecksum, BusinessPackLoader, PackRepository } from '@journeyax/business-pack';
import { hashToolInput } from '../approval/approval.store';
import { OutboxRepository } from './outbox.repository';
import { OutboxWorker, OutboxWorkerOptions } from './outbox.worker';
import {
  IConnectionOwnershipRepository,
  DurableConnectionOwnershipRepository,
} from './connection-ownership.repository';

export interface ProductionHandlersOptions {
  db?: any;
  capabilityDispatcher?: CapabilityDispatcher;
  notificationDispatcher?: NotificationDispatcher;
  ownershipRepository?: IConnectionOwnershipRepository;
  packRepo?: PackRepository;
}

export interface WorkerHealthResponse {
  status: 'ok' | 'degraded' | 'unhealthy' | 'stopped' | 'error';
  mode: 'mongodb' | 'unconfigured';
  worker: 'active' | 'inactive';
  state: 'running' | 'polling' | 'idle' | 'stopped' | 'failed_config' | 'unconfigured';
  configurationFailure: string | null;
  lastSuccessfulPoll: string | null;
  lastPollStartedAt?: string | null;
  lastError?: string | null;
  leaseStatus: {
    activeLeases: number;
    leaseDurationMs?: number;
  };
  metrics: {
    pending: number;
    leased: number;
    published: number;
    deadLetter: number;
  };
  features?: {
    activepiecesDispatch: {
      status: string;
      cutoverReady: boolean;
      notice: string;
    };
  };
  timestamp: string;
}

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private worker: OutboxWorker | null = null;
  private configurationFailure: string | null = null;
  private repo: OutboxRepository | DbOutboxRepository | null = null;
  private handlers = new Map<string, (event: any) => Promise<void>>();

  constructor() {
    // Empty dependency-free constructor for Nest DI compatibility (avoids Object token injection with emitDecoratorMetadata)
  }

  /**
   * Configuration hook for test harness and programmatic initialization.
   */
  configureHandlers(options: ProductionHandlersOptions): void {
    this.registerProductionHandlers(options);
  }

  /**
   * Registers real production OutboxWorker handlers.
   * Handlers must complete and persist their required side effect or throw
   * so retry and dead-letter applies. Never logs and acks.
   * Unimplemented event types are NOT registered so they fail closed.
   */
  registerProductionHandlers(options: ProductionHandlersOptions = {}): void {
    const { db, capabilityDispatcher, notificationDispatcher, ownershipRepository } = options;
    this.handlers.clear();

    // 1. Business Pack lifecycle events — persists audit trail or throws
    this.registerHandler('business_pack.published', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist audit logs for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling business_pack.published for tenant '${event.tenantId}' version '${event.payload?.version}'`
      );
      await db.collection('audit_logs').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'business_pack.published',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            payload: event.payload,
            processedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      // Immediately invalidate cached business pack for the affected tenant/environment
      BusinessPackLoader.invalidateAll(event.tenantId, event.environmentId);
      if (options.packRepo) {
        options.packRepo.invalidate(event.tenantId, event.environmentId as any);
      }
    });

    this.registerHandler('business_pack.rolled_back', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist audit logs for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling business_pack.rolled_back for tenant '${event.tenantId}'`
      );
      await db.collection('audit_logs').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'business_pack.rolled_back',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            payload: event.payload,
            processedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      // Immediately invalidate cached business pack for the affected tenant/environment
      BusinessPackLoader.invalidateAll(event.tenantId, event.environmentId);
      if (options.packRepo) {
        options.packRepo.invalidate(event.tenantId, event.environmentId as any);
      }
    });

    // 2. Notification dispatch — calls real NotificationDispatcher and enforces delivery persistence
    this.registerHandler('notification.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling notification.dispatch for tenant '${event.tenantId}'`
      );
      const dispatcher = notificationDispatcher || (db ? new NotificationDispatcher(db) : null);
      if (!dispatcher) {
        throw new Error(
          `[OutboxWorker] NotificationDispatcher or database connection is required to process notification.dispatch for tenant '${event.tenantId}'`
        );
      }

      const payload = event.payload || {};
      const result = await dispatcher.dispatch(
        event.tenantId,
        event.eventId,
        payload.payload || payload,
        payload.channelsConfig,
        {
          environmentId: event.environmentId,
          recipients: payload.recipients,
        }
      );

      if (!result.success) {
        const failureDetails = (result.deliveries || [])
          .filter((d: any) => d.status === 'failed')
          .map((d: any) => d.error || 'Delivery failed');
        throw new Error(
          `[OutboxWorker] Notification dispatch failed: ${failureDetails.join('; ') || 'Dispatcher reported failure'}`
        );
      }

      await this.recordAnalyticsEvent(db, {
        eventId: event.eventId,
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        category: 'notification',
        eventName: 'notification_delivered',
        status: 'success',
        metadata: {
          recipients: payload.recipients,
          providerDeliveryId: result.deliveries?.[0]?.providerDeliveryId,
        },
      });
    });

    // 3. Activepieces dispatch — invokes actual CapabilityDispatcher with Business-Pack definition and tenant credentials
    this.registerHandler('activepieces.dispatch', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling activepieces.dispatch for tenant '${event.tenantId}' toolId '${(event as any).toolId}'`
      );
      const payload = event.payload || {};

      if (!db) {
        throw new Error("[OutboxWorker] Durable database is required to resolve execution context");
      }

      // Authoritative durable execution context resolution — top-level envelope fields are mandatory
      const workspaceId = (event as any).workspaceId;
      if (!workspaceId) {
        throw new Error("[OutboxWorker] Missing mandatory top-level 'workspaceId' in outbox envelope (payload fallback prohibited)");
      }

      const targetSessionId = (event as any).sessionId;
      if (!targetSessionId) {
        throw new Error("[OutboxWorker] Missing mandatory top-level 'sessionId' in outbox envelope (payload fallback prohibited)");
      }

      const toolId = (event as any).toolId;
      if (!toolId) {
        throw new Error("[OutboxWorker] Missing mandatory top-level 'toolId' in outbox envelope (payload fallback prohibited)");
      }

      const workspaceDoc = await db.collection('workspaces').findOne({
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        workspaceId,
      });
      if (!workspaceDoc) {
        throw new Error(
          `[OutboxWorker] Durable workspace record not found for tenant '${event.tenantId}', env '${event.environmentId}', workspace '${workspaceId}'`
        );
      }

      const stageId = workspaceDoc.currentStage || workspaceDoc.stageId;
      const packVersionId = (event as any).packVersionId || workspaceDoc.packVersionId;
      if (!stageId || !packVersionId) {
        throw new Error(
          `[OutboxWorker] Durable workspace record '${workspaceId}' lacks required currentStage or packVersionId`
        );
      }

      const sessionDoc = await db.collection('sessions').findOne({
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        workspaceId,
        sessionId: targetSessionId,
      });
      if (!sessionDoc) {
        throw new Error(
          `[OutboxWorker] Durable session record not found for session '${targetSessionId}' in workspace '${workspaceId}'`
        );
      }

      const principalRole = sessionDoc.principalRole || sessionDoc.role;
      const principalId = sessionDoc.principalId || sessionDoc.userId || sessionDoc.email;
      if (!principalRole) {
        throw new Error(
          `[OutboxWorker] Durable session '${targetSessionId}' lacks required principalRole`
        );
      }

      // Authoritative active business pack release pointer lookup strictly scoped to tenant and environment (no fallback to workspace packVersionId)
      const pointer = await db.collection('business_pack_pointers').findOne({
        tenantId: event.tenantId,
        $or: [{ channel: event.environmentId }, { environmentId: event.environmentId }],
      });

      if (!pointer) {
        throw new Error(
          `[OutboxWorker] Active business pack pointer not found for tenant '${event.tenantId}' (${event.environmentId}); failing closed (fallback prohibited)`
        );
      }

      const activeVersion = pointer.activeVersionId || pointer.activeVersion;
      if (!activeVersion) {
        throw new Error(
          `[OutboxWorker] Active business pack pointer for tenant '${event.tenantId}' (${event.environmentId}) lacks activeVersionId; failing closed`
        );
      }

      if (activeVersion !== packVersionId) {
        throw new Error(
          `[OutboxWorker] Workspace packVersionId '${packVersionId}' does not match active release pointer '${activeVersion}' for tenant '${event.tenantId}' (${event.environmentId})`
        );
      }

      const pointerChecksum = typeof pointer.checksum === 'string' ? pointer.checksum.trim() : '';
      if (!pointerChecksum) {
        throw new Error(
          `[OutboxWorker] Active business pack pointer for tenant '${event.tenantId}' (${event.environmentId}) lacks mandatory checksum; failing closed`
        );
      }

      // Load immutable published Business Pack release strictly for exact environment (NO environmentId='all')
      const releaseDoc = await db.collection('business_pack_releases').findOne({
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        $or: [{ versionId: packVersionId }, { version: packVersionId }],
        $and: [
          {
            $or: [
              { status: { $in: ['published', 'active'] } },
              { status: { $exists: false } },
            ],
          },
        ],
      });
      if (!releaseDoc) {
        throw new Error(
          `[OutboxWorker] Published business pack release '${packVersionId}' not found for tenant '${event.tenantId}' with exact environment '${event.environmentId}'`
        );
      }

      // Validate release checksum and recompute canonical Business Pack checksum
      const releaseChecksum = typeof releaseDoc.checksum === 'string' ? releaseDoc.checksum.trim() : '';
      if (!releaseChecksum) {
        throw new Error(
          `[OutboxWorker] Business pack release '${packVersionId}' lacks mandatory checksum; failing closed`
        );
      }

      const packPayload = releaseDoc.packData || {
        manifest: releaseDoc.manifest,
        profile: releaseDoc.profile,
        vocabulary: releaseDoc.vocabulary,
        entities: releaseDoc.entities,
        conversationPolicy: releaseDoc.conversationPolicy,
        modelPolicy: releaseDoc.modelPolicy,
        agents: releaseDoc.agents,
        journeys: releaseDoc.journeys,
        rules: releaseDoc.rules,
        capabilities: releaseDoc.capabilities,
        experience: releaseDoc.experience,
        evaluations: releaseDoc.evaluations,
        extensions: releaseDoc.extensions || {},
      };
      const packToHash = releaseDoc.manifest
        ? packPayload
        : (({ _id, checksum, status, publishedAt, publishedBy, tenantId: _t, environmentId: _e, version: _v, versionId: _vi, ...rest }) => Object.keys(rest).length > 0 ? rest : releaseDoc)(releaseDoc);

      const computedChecksum = computePackChecksum(packToHash as any);
      if (computedChecksum !== releaseChecksum) {
        throw new Error(
          `[OutboxWorker] Canonical Business Pack checksum mismatch for release '${packVersionId}': stored '${releaseChecksum}', recomputed '${computedChecksum}'`
        );
      }
      if (computedChecksum !== pointerChecksum) {
        throw new Error(
          `[OutboxWorker] Business Pack checksum mismatch between release ('${computedChecksum}') and active pointer ('${pointerChecksum}') for tenant '${event.tenantId}' (${event.environmentId})`
        );
      }

      // Fail closed when stageBindings is missing, the current stage binding is absent, or the tool is not explicitly allowed
      const stageBindings = releaseDoc.capabilities?.stageBindings;
      if (!Array.isArray(stageBindings) || stageBindings.length === 0) {
        throw new Error(
          `[OutboxWorker] Published business pack release '${packVersionId}' lacks mandatory 'stageBindings'; failing closed`
        );
      }

      const currentStageBinding = stageBindings.find((sb: any) => sb.stageId === stageId);
      if (!currentStageBinding) {
        throw new Error(
          `[OutboxWorker] Stage binding for stage '${stageId}' is absent in published business pack release '${packVersionId}'; failing closed`
        );
      }

      const isToolAllowedInStage = Array.isArray(currentStageBinding.tools) && currentStageBinding.tools.some((t: any) => t.toolId === toolId);
      if (!isToolAllowedInStage) {
        throw new Error(
          `[OutboxWorker] Tool '${toolId}' is not allowed in stage '${stageId}' by published business pack release '${packVersionId}'`
        );
      }

      // Resolve stage-scoped ToolDefinition from release (never trust payload for policy/risk/sideEffect)
      const toolDefs: ToolDefinition[] = releaseDoc.capabilities?.toolDefinitions || [];
      const toolDef = toolDefs.find((t: any) => t.toolId === toolId);
      if (!toolDef) {
        throw new Error(
          `[OutboxWorker] Tool '${toolId}' is not defined in published business pack release '${packVersionId}'`
        );
      }

      // Resolve ToolBinding from release strictly enforcing exact tenant/environment (NO environmentId='all')
      const toolBindings: ToolBinding[] = releaseDoc.capabilities?.toolBindings || [];
      const toolBinding = toolBindings.find(
        (b: any) =>
          b.toolId === toolId &&
          b.environmentId === event.environmentId &&
          (!b.tenantId || b.tenantId === event.tenantId)
      );
      if (!toolBinding) {
        throw new Error(
          `[OutboxWorker] ToolBinding for '${toolId}' with exact environment '${event.environmentId}' not found in published business pack release '${packVersionId}'`
        );
      }
      if (toolBinding.executor?.type !== 'activepieces_flow') {
        throw new Error(
          `[OutboxWorker] ToolBinding for '${toolId}' does not use 'activepieces_flow' executor (found '${toolBinding.executor?.type}')`
        );
      }

      const boundFlowId = toolBinding.executor.flowId;
      const boundConnectionRef = toolBinding.executor.connectionRef;
      if (!boundFlowId || !boundConnectionRef) {
        throw new Error(
          `[OutboxWorker] ToolBinding for '${toolId}' lacks mandatory flowId or connectionRef`
        );
      }

      // Validate that connection permits the configured flow and piece
      const configuredPieceId = (toolBinding.executor as any)?.pieceId || (toolDef as any)?.pieceId || (toolBinding as any)?.pieceId;
      const ownershipRepo = ownershipRepository || (db ? new DurableConnectionOwnershipRepository(() => db) : null);
      if (!ownershipRepo) {
        throw new Error(
          `[OutboxWorker] Durable connection ownership repository required to validate connection for tenant '${event.tenantId}'`
        );
      }
      const isConnectionPermitted = await ownershipRepo.validateOwnership(
        event.tenantId,
        event.environmentId,
        boundConnectionRef,
        {
          flowId: boundFlowId,
          pieceId: configuredPieceId,
        }
      );
      if (!isConnectionPermitted) {
        throw new Error(
          `[OutboxWorker] Connection '${boundConnectionRef}' is not authorized for tenant '${event.tenantId}' (${event.environmentId}) or does not permit flow '${boundFlowId}'${configuredPieceId ? ` and piece '${configuredPieceId}'` : ''}; failing closed`
        );
      }

      // Payload may carry only validated input / reference IDs, never executable policy
      if (payload.flowId && payload.flowId !== boundFlowId) {
        throw new Error(
          `[OutboxWorker] Forged flowId in payload '${payload.flowId}' does not match pack binding '${boundFlowId}'`
        );
      }
      if (payload.connectionRef && payload.connectionRef !== boundConnectionRef) {
        throw new Error(
          `[OutboxWorker] Forged connectionRef in payload '${payload.connectionRef}' does not match pack binding '${boundConnectionRef}'`
        );
      }

      // Resolve tenant/environment-configured activepieces secrets — NO global fallbacks
      const apApiKeyDoc = await db.collection('tenant_secrets').findOne({
        tenantId: event.tenantId,
        $or: [{ environmentId: event.environmentId }, { environmentId: 'all' }],
        secretRef: 'activepieces_api_key',
      });
      const apWebhookDoc = await db.collection('tenant_secrets').findOne({
        tenantId: event.tenantId,
        $or: [{ environmentId: event.environmentId }, { environmentId: 'all' }],
        secretRef: 'activepieces_webhook_secret',
      });

      if (!apApiKeyDoc?.value || !apWebhookDoc?.value) {
        throw new Error(
          `[OutboxWorker] Activepieces tenant secrets (activepieces_api_key / activepieces_webhook_secret) not configured for tenant '${event.tenantId}' (${event.environmentId}); failing closed (no global fallback)`
        );
      }

      // Use tenant-specific CapabilityDispatcher unless a custom mock dispatcher is injected for testing
      const isCustomMock =
        capabilityDispatcher &&
        typeof (capabilityDispatcher as any).dispatch === 'function' &&
        capabilityDispatcher.constructor.name !== 'CapabilityDispatcher';

      const capDispatcher = isCustomMock
        ? capabilityDispatcher
        : new CapabilityDispatcher({
            activepiecesApiUrl: process.env.ACTIVEPIECES_API_URL,
            activepiecesApiKey: apApiKeyDoc.value,
            activepiecesWebhookSecret: apWebhookDoc.value,
            validateConnectionOwnership: async (t, e, c) => {
              if (ownershipRepository) {
                return ownershipRepository.validateOwnership(t, e, c, {
                  flowId: boundFlowId,
                  pieceId: configuredPieceId,
                });
              }
              if (db) {
                const repo = new DurableConnectionOwnershipRepository(() => db);
                return repo.validateOwnership(t, e, c, {
                  flowId: boundFlowId,
                  pieceId: configuredPieceId,
                });
              }
              return false;
            },
          });

      const ctx: ExecutionContext = {
        workspaceId,
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        sessionId: targetSessionId,
        stageId,
        packVersionId,
        correlationId: event.eventId,
        idempotencyKey: event.eventId,
        principalRole,
        principalId,
      };

      // Side-effecting dispatch policy evaluation strictly based on Business-Pack definition
      const isSideEffecting =
        toolDef.sideEffect === 'write' ||
        toolDef.sideEffect === 'transactional' ||
        toolDef.risk === 'medium' ||
        toolDef.risk === 'high' ||
        toolDef.risk === 'critical' ||
        toolBinding.policy?.requiresConfirmation === true ||
        toolDef.approvalPolicy?.requiresApproval === true;

      let userConfirmationConfirmed = false;
      if (isSideEffecting) {
        const approvalId = (event as any).approvalId;
        if (!approvalId) {
          throw new Error(
            `[OutboxWorker] Side-effecting activepieces.dispatch for tool '${toolDef.toolId}' requires an authoritative top-level 'approvalId' in outbox envelope`
          );
        }

        const now = new Date();
        const approvalCol = db.collection(COLLECTION_TOOL_APPROVALS);
        const approval = await approvalCol.findOne({
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          workspaceId,
          toolId,
          status: 'approved',
          $and: [
            { $or: [{ approvalRequestId: approvalId }, { approvalId }] },
            {
              $or: [
                { eventId: event.eventId },
                { executionReference: (event as any).executionReference },
              ],
            },
          ],
        } as any);

        if (!approval) {
          throw new Error(
            `[OutboxWorker] Authoritative approval record '${approvalId}' not found for tenant '${event.tenantId}', env '${event.environmentId}', workspace '${workspaceId}', tool '${toolId}', event '${event.eventId}'`
          );
        }

        // Validate expiry
        if (!approval.expiresAt || new Date(approval.expiresAt) <= now) {
          throw new Error(`[OutboxWorker] Approval record '${approvalId}' has expired`);
        }

        // Require exact immutable bindings: sessionId, stageId, packVersionId, principalRole, principalId, executionReference, inputHash
        if (!approval.sessionId || approval.sessionId !== targetSessionId) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' sessionId '${approval.sessionId}' does not match target session '${targetSessionId}'`
          );
        }
        if (!approval.stageId || approval.stageId !== stageId) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' stageId '${approval.stageId}' does not match workspace stage '${stageId}'`
          );
        }
        if (!approval.packVersionId || approval.packVersionId !== packVersionId) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' packVersionId '${approval.packVersionId}' does not match workspace pack version '${packVersionId}'`
          );
        }
        if (!approval.principalRole || approval.principalRole !== principalRole) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' principalRole '${approval.principalRole}' does not match session role '${principalRole}'`
          );
        }
        if (!approval.principalId) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' lacks mandatory principalId binding`
          );
        }
        if (!approval.executionReference || approval.executionReference !== (event as any).executionReference) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' executionReference '${approval.executionReference}' does not match event executionReference '${(event as any).executionReference}'`
          );
        }
        if (!approval.inputHash) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' lacks mandatory inputHash binding`
          );
        }
        const { correlationId: _cid, ...cleanPayload } = payload;
        const candidateInputs = [
          cleanPayload,
          payload,
          payload.input !== undefined ? payload.input : undefined,
        ].filter((x) => x !== undefined);

        const matchedHash = candidateInputs.some((candidate) => hashToolInput(candidate) === approval.inputHash);
        if (!matchedHash) {
          throw new Error(
            `[OutboxWorker] Approval '${approvalId}' inputHash '${approval.inputHash}' does not match payload hash '${hashToolInput(cleanPayload)}'`
          );
        }

        // Atomically consume/link the approval to this event (idempotent only for the same event)
        const updateRes = await approvalCol.findOneAndUpdate(
          {
            _id: approval._id,
            status: 'approved',
            $or: [
              { consumedByEventId: { $exists: false } },
              { consumedByEventId: null },
              { consumedByEventId: event.eventId },
            ],
          },
          {
            $set: {
              consumedByEventId: event.eventId,
              consumedAt: now,
            },
          },
          { returnDocument: 'after' }
        );

        const updatedDoc = (updateRes && typeof updateRes === 'object' && 'value' in updateRes)
          ? (updateRes as any).value
          : updateRes;
        if (!updatedDoc || (updatedDoc.consumedByEventId && updatedDoc.consumedByEventId !== event.eventId)) {
          throw new Error(
            `[OutboxWorker] Approval record '${approvalId}' has already been consumed by another execution; replay rejected`
          );
        }

        userConfirmationConfirmed = true;
      }

      const request: ExecutionRequest = {
        toolId: toolDef.toolId,
        input: payload.input || {},
        idempotencyKey: event.eventId,
        userConfirmationConfirmed,
      };

      const dispatchResult = await capDispatcher.dispatch(
        toolDef,
        toolBinding,
        request,
        ctx
      );

      if (dispatchResult.status !== 'success') {
        throw new Error(
          `[OutboxWorker] Activepieces execution failed with status '${dispatchResult.status}': ${dispatchResult.error || 'Execution did not succeed'}`
        );
      }

      if (db) {
        await db.collection('activepieces_executions').updateOne(
          { eventId: event.eventId },
          {
            $set: {
              tenantId: event.tenantId,
              environmentId: event.environmentId,
              flowId: boundFlowId,
              connectionRef: boundConnectionRef,
              toolId,
              output: dispatchResult.output,
              status: 'success',
              executedAt: new Date().toISOString(),
            },
            $setOnInsert: {
              eventId: event.eventId,
            },
          },
          { upsert: true }
        );
        await this.recordAnalyticsEvent(db, {
          eventId: event.eventId,
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          workspaceId,
          sessionId: targetSessionId,
          toolId,
          packVersionId,
          category: 'tool',
          eventName: 'tool_executed',
          status: 'success',
          durationMs: (dispatchResult as any)?.durationMs,
          metadata: {
            flowId: boundFlowId,
            connectionRef: boundConnectionRef,
          },
        });
      }
    });

    // 4. Order committed — persists side effect or throws
    this.registerHandler('order.committed', async (event) => {
      if (!db) {
        throw new Error(
          `[OutboxWorker] Database connection is required to persist order events for '${event.eventType}'`
        );
      }
      this.logger.log(
        `[OutboxWorker] Handling order.committed for tenant '${event.tenantId}' orderId '${event.payload?.orderId}'`
      );
      await db.collection('order_events').updateOne(
        { eventId: event.eventId },
        {
          $setOnInsert: {
            eventId: event.eventId,
            eventType: 'order.committed',
            tenantId: event.tenantId,
            environmentId: event.environmentId,
            orderId: event.payload?.orderId,
            payload: event.payload,
            committedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );
    });

    // 5. Journey turn completed — asynchronously ingests analytics event without blocking runtime
    this.registerHandler('journey.turn_completed', async (event) => {
      this.logger.log(
        `[OutboxWorker] Handling journey.turn_completed for tenant '${event.tenantId}' workspace '${event.payload?.workspaceId}'`
      );
      if (db) {
        await this.recordAnalyticsEvent(db, {
          eventId: event.eventId,
          tenantId: event.tenantId,
          environmentId: event.environmentId,
          workspaceId: event.payload?.workspaceId || (event as any).workspaceId,
          sessionId: (event as any).sessionId,
          packVersionId: (event as any).packVersionId,
          category: 'journey',
          eventName: 'stage_transition',
          stageId: event.payload?.stage,
          durationMs: event.payload?.durationMs,
          status: 'completed',
          metadata: { decisionType: event.payload?.decisionType },
        });
      }
    });

    // 6. Streaming analytics event ingestion — durable and non-blocking
    this.registerHandler('analytics.event', async (event) => {
      if (!db) {
        throw new Error("[OutboxWorker] Database connection required to persist analytics event");
      }
      const payload = event.payload || {};
      await this.recordAnalyticsEvent(db, {
        eventId: event.eventId,
        tenantId: event.tenantId,
        environmentId: event.environmentId,
        projectId: payload.projectId || event.tenantId,
        teamId: payload.teamId,
        workspaceId: payload.workspaceId || (event as any).workspaceId,
        sessionId: payload.sessionId || (event as any).sessionId,
        category: payload.category || 'journey',
        eventName: payload.eventName || 'custom_event',
        stageId: payload.stageId,
        fromStage: payload.fromStage,
        toStage: payload.toStage,
        durationMs: payload.durationMs,
        tokens: payload.tokens,
        costUsd: payload.costUsd,
        modelId: payload.modelId,
        provider: payload.provider,
        toolId: payload.toolId,
        status: payload.status || 'success',
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        packId: payload.packId,
        packVersionId: payload.packVersionId || (event as any).packVersionId,
        principalId: payload.principalId,
        principalRole: payload.principalRole,
        metadata: payload.metadata,
      });
    });
  }

  private async recordAnalyticsEvent(
    db: any,
    record: Partial<AnalyticsEventRecord> & {
      tenantId: string;
      environmentId: EnvironmentId;
      category: AnalyticsCategory;
      eventName: string;
    }
  ): Promise<void> {
    if (!db) return;
    try {
      const col = db.collection(COLLECTION_ANALYTICS_EVENTS);
      if (col && typeof col.insertOne === 'function') {
        await col.insertOne({
          eventId: record.eventId || `an_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          timestamp: new Date(),
          status: record.status || 'success',
          ...record,
        });
      }
    } catch (err: any) {
      this.logger.warn(`[OutboxWorker] Failed to asynchronously record analytics event: ${err.message}`);
    }
  }

  /**
   * Register a delivery handler for a specific event type.
   */
  registerHandler(eventType: string, handler: (event: any) => Promise<void>): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Dispatches an outbox event to its registered handler.
   * Fails closed: if no handler is registered or delivery fails, throws an error so the outbox
   * record remains in retryable or dead-letter state. Never logs and acks.
   */
  async dispatchEvent(event: any): Promise<void> {
    const handler = this.handlers.get(event.eventType);
    if (!handler) {
      throw new Error(
        `[OutboxWorker] No handler registered for event type '${event.eventType}'. Delivery failed and remains retryable or dead-letter.`
      );
    }
    await handler(event);
  }

  async onModuleInit(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri || uri.trim() === '') {
      this.configurationFailure = 'Missing required MONGODB_URI for durable outbox storage';
      this.logger.warn(`OutboxWorker not started: ${this.configurationFailure}`);
      return;
    }

    try {
      const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
      const { db } = await connectToDatabase(uri, dbName);
      const dbRepo = new DbOutboxRepository(db);
      this.repo = dbRepo;

      const ownershipRepo = new DurableConnectionOwnershipRepository(() => db);
      const capabilityDispatcher = new CapabilityDispatcher({
        activepiecesApiUrl: process.env.ACTIVEPIECES_API_URL,
        validateConnectionOwnership: (tenantId, environmentId, connectionRef) =>
          ownershipRepo.validateOwnership(tenantId, environmentId, connectionRef),
      });
      const notificationDispatcher = new NotificationDispatcher(db, {
        capabilityDispatcher,
        validateConnectionOwnership: (tenantId, environmentId, connectionRef) =>
          ownershipRepo.validateOwnership(tenantId, environmentId, connectionRef),
      });

      // Register durable production handlers wired to the database before worker start
      this.registerProductionHandlers({
        db,
        capabilityDispatcher,
        notificationDispatcher,
        ownershipRepository: ownershipRepo,
      });

      this.worker = new OutboxWorker(
        dbRepo as any,
        {
          dispatcher: async (event) => {
            await this.dispatchEvent(event);
          },
          workerId: `worker-${process.pid}-${Math.random().toString(36).substring(2, 7)}`,
          pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 2000,
          leaseDurationMs: Number(process.env.OUTBOX_LEASE_DURATION_MS) || 30000,
          batchSize: Number(process.env.OUTBOX_BATCH_SIZE) || 10,
        }
      );

      this.worker.start();
      this.configurationFailure = null;
      this.logger.log(`OutboxWorker successfully started with durable MongoDB storage`);
    } catch (err: any) {
      this.configurationFailure = `Durable storage connection failed: ${err.message}`;
      this.logger.error(`Failed to initialize OutboxWorker: ${this.configurationFailure}`);
      this.worker = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      this.logger.log('Stopping OutboxWorker gracefully...');
      this.worker.stop();
      this.worker = null;
    }
  }

  /**
   * For testing or explicit wiring with a specific repository instance
   */
  startWithRepository(
    repo: OutboxRepository | DbOutboxRepository,
    dispatcher?: (event: any) => Promise<void>,
    options?: Omit<OutboxWorkerOptions, 'dispatcher'>
  ): OutboxWorker {
    if (this.worker) {
      this.worker.stop();
    }
    this.repo = repo;
    const effectiveDispatcher = dispatcher || (async (evt) => {
      await this.dispatchEvent(evt);
    });
    this.worker = new OutboxWorker(
      repo as any,
      {
        ...options,
        dispatcher: effectiveDispatcher,
      }
    );
    this.worker.start();
    this.configurationFailure = null;
    return this.worker;
  }

  stopWorker(): void {
    if (this.worker) {
      this.worker.stop();
    }
  }

  getWorker(): OutboxWorker | null {
    return this.worker;
  }

  getConfigurationFailure(): string | null {
    return this.configurationFailure;
  }

  setConfigurationFailure(failure: string | null): void {
    this.configurationFailure = failure;
  }

  async getHealthInfo(tenantId?: string): Promise<WorkerHealthResponse> {
    if (!this.worker) {
      return {
        status: 'unhealthy',
        mode: 'unconfigured',
        worker: 'inactive',
        state: this.configurationFailure ? 'failed_config' : 'unconfigured',
        configurationFailure: this.configurationFailure || 'OutboxWorker is not instantiated',
        lastSuccessfulPoll: null,
        leaseStatus: { activeLeases: 0 },
        metrics: { pending: 0, leased: 0, published: 0, deadLetter: 0 },
        features: {
          activepiecesDispatch: {
            status: 'handler_live_producer_wired',
            cutoverReady: false,
            notice:
              'activepieces.dispatch handler is registered and wired to approved capability execution; full production cutover requires end-to-end live testing with production Activepieces cluster',
          },
        },
        timestamp: new Date().toISOString(),
      };
    }

    const state = this.worker.getState();
    let metrics = { pending: 0, leased: 0, published: 0, deadLetter: 0 };
    try {
      metrics = await this.worker.getMetrics(tenantId);
    } catch (err: any) {
      this.logger.warn(`Failed to retrieve outbox metrics: ${err.message}`);
    }

    const isRunning = state.running;
    let status: WorkerHealthResponse['status'] = 'ok';
    if (!isRunning) {
      status = 'stopped';
    } else if (metrics.deadLetter > 50) {
      status = 'degraded';
    }

    return {
      status,
      mode: 'mongodb',
      worker: isRunning ? 'active' : 'inactive',
      state: state.status,
      lastSuccessfulPoll: state.lastSuccessfulPollAt,
      lastPollStartedAt: state.lastPollStartedAt,
      lastError: state.lastError,
      leaseStatus: {
        activeLeases: state.activeLeasesCount,
        leaseDurationMs: state.leaseDurationMs,
      },
      metrics,
      features: {
        activepiecesDispatch: {
          status: 'handler_live_producer_wired',
          cutoverReady: false,
          notice:
            'activepieces.dispatch handler is registered and wired to approved capability execution; full production cutover requires end-to-end live testing with production Activepieces cluster',
        },
      },
      configurationFailure: null,
      timestamp: new Date().toISOString(),
    };
  }
}
