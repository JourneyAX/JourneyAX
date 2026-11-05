import {
  TurnCommand,
  TurnResult,
  Decision,
  EnvironmentId,
  DuplicateTurnError,
  WorkspaceReleasePins,
} from '@journeyax/journey-core';
import {
  BusinessPackRelease,
  computePackChecksum,
  getVerifiedBusinessPackMetadata,
} from '@journeyax/business-pack';
import { connectToDatabase } from '@journeyax/database';
import { PackRepository } from './pack.repository';
import { WorkspaceRepository } from './workspace.repository';
import { JourneyResolver } from './journey.resolver';
import { AgentRouter } from './agent.router';
import { ModelGateway } from './model.gateway';
import { CapabilityGateway } from './capability.gateway';
import { ApprovalService } from './approval.service';
import { ExecutionRepository } from './execution.repository';
import { OutboxRepository } from './outbox.repository';
import { PresentationPort } from './presentation.port';
import { appendHistory, customerMessageId, assistantMessageId } from '../conversation';
import {
  OkfKnowledgeControlPlane,
  type KnowledgeControlPlanePort,
} from './knowledge-control-plane';
import { AgentTurnLoop } from '../agent/agent-loop';
import { MongoRetailIqIdentityPort, type RetailIqIdentityPort } from '../agent/iq-customer-identity';
import { TurnTranscriptStore } from './transcript.store';
import { KnowledgeGapRepository } from './knowledge-gap.repository';
import { ProductGuideRepository } from './product-guide.repository';
import { ContentPageRepository } from './content-page.repository';
import { FormSubmissionRepository } from './form-submission.repository';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
import { CatalogueIndexRegistry, openCatalogueDatabase } from '../capabilities/catalogue-index';
import { CompanyDirectory, defaultCompanyDirectory } from './company-directory';
import { resolveCatalogMapping } from '@journeyax/business-pack';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import agentLoopDefaults from '../defaults/agent-loop.json';
import { KnowledgeSearchHandler } from '../capabilities/handlers/knowledge-search.handler';
import { resolveCustomerEventAction } from './customer-event-policy';

export interface TurnTiming {
  tenantId?: string;
  turnId?: string;
  timeToFirstEventMs: number | null;
  timeToFirstTextMs: number | null;
  interpretMs: number;
  responseMs: number;
  phraseMs: number;
  retrievalMs: number;
  totalMs: number;
  modelCalls: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export class TurnApplicationService {
  constructor(
    public readonly packRepo: PackRepository = new PackRepository(),
    public readonly workspaceRepo: WorkspaceRepository = new WorkspaceRepository(),
    public readonly journeyResolver: JourneyResolver = new JourneyResolver(),
    public readonly agentRouter: AgentRouter = new AgentRouter(),
    public readonly modelGateway: ModelGateway = new ModelGateway(),
    public readonly capabilityGateway: CapabilityGateway = new CapabilityGateway(),
    public readonly approvalService: ApprovalService = new ApprovalService(),
    public readonly executionRepo: ExecutionRepository = new ExecutionRepository(),
    public readonly outboxRepo: OutboxRepository = new OutboxRepository(),
    public readonly presentationPort: PresentationPort = new PresentationPort(),
    public readonly knowledgeControlPlane: KnowledgeControlPlanePort = new OkfKnowledgeControlPlane(),
    public readonly transcriptStore: TurnTranscriptStore = new TurnTranscriptStore(),
    public readonly knowledgeGapRepo: KnowledgeGapRepository = new KnowledgeGapRepository(),
    public readonly productGuideRepo: ProductGuideRepository = new ProductGuideRepository(),
    public readonly contentPageRepo: ContentPageRepository = new ContentPageRepository(),
    public readonly formSubmissionRepo: FormSubmissionRepository = new FormSubmissionRepository(),
    public readonly companyDirectory: CompanyDirectory = defaultCompanyDirectory(),
    public readonly scopedPorts?: {
      iqClient?: import('@journeyax/jax-iq').IqClient;
      retailIqIdentity?: RetailIqIdentityPort;
      /** Explicit isolated draft stores; absent in the connected application. */
      commerceStores?: { quotes: Map<string, any>; carts: Map<string, any>; products: readonly unknown[] };
    }
  ) {
    if (this.approvalService && !this.approvalService.getOutboxRepo()) {
      this.approvalService.setOutboxRepo(this.outboxRepo);
    }
  }

  /**
   * Loads the in-memory catalogue copy of the tenants named in CATALOGUE_INDEX_WARM_TENANTS (comma separated), so their first
   * customer does not wait for it. Does nothing when the index is off; a tenant that fails to load is only logged.
   */
  async warmCatalogueIndex(): Promise<void> {
    const registry = CatalogueIndexRegistry.shared();
    if (!registry.isEnabled()) return;
    const tenants = (process.env.CATALOGUE_INDEX_WARM_TENANTS || '').split(',').map((tenant) => tenant.trim()).filter(Boolean);
    for (const tenantId of tenants) {
      try {
        const release = await this.packRepo.loadActivePack(tenantId, (process.env.COMMERCE_ENVIRONMENT || 'production') as EnvironmentId);
        await registry.warm({ tenantId, mapping: resolveCatalogMapping((release as any).catalogMapping), getDb: () => openCatalogueDatabase() });
      } catch (err: any) {
        console.warn(`[CatalogueIndex] could not warm tenant=${tenantId}: ${err?.message || err}`);
      }
    }
  }

  public createWorkspacePins(release: BusinessPackRelease): WorkspaceReleasePins {
    const verified = getVerifiedBusinessPackMetadata(release);
    const knowledge = release.knowledgeModel?.type === 'okf_release'
      ? release.knowledgeModel
      : undefined;
    const now = new Date().toISOString();
    return {
      packChecksum: verified?.checksum || computePackChecksum(release),
      okfReleaseId: knowledge?.releaseId,
      okfChecksum: knowledge?.checksum,
      knowledgeEvaluatedAt: knowledge ? now : undefined,
      pinnedAt: now,
    };
  }

  /**
   * Executes a single turn.
   *
   * @param command         - the TurnCommand from the controller
   * @param preloadedRelease - when provided by RuntimeService.runTurn, this is the pack
   *                           that was ALREADY loaded and checksum-validated by assertCutoverApproved.
   *                           Using it here avoids a redundant second loadActivePack call and
   *                           guarantees the exact validated version/checksum is what executes.
   */
  /**
   * Executes a single turn buffered.
   */
  async executeTurn(command: TurnCommand, preloadedRelease?: any): Promise<TurnResult> {
    return this.executeTurnStream(command, preloadedRelease, () => {});
  }

  /**
   * Executes a single turn with genuine streaming event sink boundary.
   * Forward real model/runtime events in order: session, trace, token, capability, uiAction, data, error and done.
   */
  async executeTurnStream(
    command: TurnCommand,
    preloadedRelease?: any,
    sink: (event: string, data: any) => void = () => {}
  ): Promise<TurnResult> {
    let effectiveRelease = preloadedRelease;
    let effectiveSink = sink;
    if (typeof preloadedRelease === 'function') {
      effectiveSink = preloadedRelease;
      effectiveRelease = undefined;
    }

    const turnStartTime = Date.now();
    let timeToFirstEventMs: number | null = null;
    let timeToFirstTextMs: number | null = null;

    const timingSink = (event: string, data: any) => {
      const elapsed = Date.now() - turnStartTime;
      if (timeToFirstEventMs === null && event !== 'session') {
        timeToFirstEventMs = elapsed;
      }
      if (timeToFirstTextMs === null && event === 'token') {
        timeToFirstTextMs = elapsed;
      }
      effectiveSink(event, data);
    };

    try {
      const tenantId = command.tenantId;
      const envId: EnvironmentId = command.environmentId || 'production';
      const workspaceId = command.workspaceId || command.sessionId;
      const turnId = command.turnId;

      // 1. Forward session event at start of streaming boundary
      timingSink('session', { sessionId: command.sessionId || workspaceId });

      // 2. Authoritative Business Pack resolution
      // If a pre-validated release was passed by the cutover gate, use it directly.
      // This eliminates the double loadActivePack call and guarantees the exact
      // version and checksum that was validated is what executes — no TOCTOU window.
      const release = effectiveRelease ?? await this.packRepo.loadActivePack(tenantId, envId);

      // 3. Load existing Workspace State (if present)
      let workspace =
        typeof this.workspaceRepo?.load === 'function'
          ? await this.workspaceRepo.load(tenantId, envId, workspaceId)
          : null;

      // 3-pin. The runtime gate resolves a different release for a pinned workspace only when the pack's
      // opt-in idle re-pin policy applies and the new release can host the conversation; rebind pins then.
      if (workspace?.pins?.packChecksum && workspace.pins.packChecksum !== (getVerifiedBusinessPackMetadata(release)?.checksum || computePackChecksum(release))) {
        const previous = workspace.pins;
        workspace.pins = { ...this.createWorkspacePins(release), repinnedAt: new Date().toISOString() };
        workspace.packVersionId = release.manifest.version || release.manifest.packId;
        workspace.pinsRebound = true;
        console.log(JSON.stringify({ event: 'workspace.repinned', tenantId, workspaceId, fromChecksum: previous.packChecksum, toChecksum: workspace.pins.packChecksum }));
      }

      // 3a. Turn Replay Rejection — Duplicate turnId is rejected unconditionally regardless of tool execution!
      if (turnId && workspace && workspace.lastProcessedTurnId === turnId) {
        throw new DuplicateTurnError(turnId);
      }

      // 3-event. Customer Event Policy Check (Prompt P3 & P4)
      const customerEvent = command.customerEvent || (command as any).customer_event;
      if (customerEvent && customerEvent.type) {
        if (!workspace) {
          workspace = await this.workspaceRepo.getOrCreate(
            tenantId,
            envId,
            workspaceId,
            'unassigned',
            'initial',
            undefined,
            release.manifest.version || release.manifest.packId,
            this.createWorkspacePins(release)
          );
        }

        const recordedAt = new Date().toISOString();
        workspace.facts['last_customer_event'] = {
          value: customerEvent,
          source: 'customer',
          confidence: 1,
          extractedAt: recordedAt,
        };

        const existingLog = Array.isArray(workspace.facts['customer_events_log']?.value)
          ? workspace.facts['customer_events_log'].value
          : [];
        workspace.facts['customer_events_log'] = {
          value: [...existingLog, customerEvent],
          source: 'customer',
          confidence: 1,
          extractedAt: recordedAt,
        };

        const eventAction = resolveCustomerEventAction(customerEvent.type, release);
        if (eventAction === 'record_only') {

          // Append compact record to conversation history for history hygiene
          appendHistory(
            workspace,
            [
              {
                role: 'system',
                content: `[Customer Event: ${customerEvent.type}${customerEvent.sourceCard ? ` from ${typeof customerEvent.sourceCard === 'string' ? customerEvent.sourceCard : customerEvent.sourceCard.cardType || customerEvent.sourceCard.id}` : ''}]`,
                turnId,
                timestamp: recordedAt,
              },
            ],
            release.extensions?.dialoguePolicy?.history
          );

          await this.commitWorkspace(
            workspace,
            turnId,
            envId,
            tenantId,
            workspaceId,
            'record_event' as any,
            command.correlationId,
            {
              customerMessage: `[Event: ${customerEvent.type}]`,
              assistantReply: '',
              turnStartTime,
              sessionId: command.sessionId,
            }
          );

          timingSink('done', {
            sessionId: command.sessionId || workspaceId,
            workspaceId,
            turnId,
            decision: {
              type: 'record_event',
              reason: `Customer event '${customerEvent.type}' recorded without agent turn per tenant policy`,
            },
            trace: {
              stage: workspace.currentStage || 'initial',
              transitions: [],
              decisionsMade: [],
              engine: 'agent',
              eventRecorded: true,
              eventType: customerEvent.type,
            },
          });

          return {
            workspace,
            decision: {
              decisionId: `dec_event_${Date.now()}`,
              type: 'record_event' as any,
              reason: `Customer event '${customerEvent.type}' recorded without agent turn per tenant policy`,
              payload: { event: customerEvent },
              createdAt: recordedAt,
            },
            assistantMessage: undefined,
            uiInstructions: [],
            executedCapabilities: [],
            trace: {
              stage: workspace.currentStage || 'initial',
              transitions: [],
              decisionsMade: [],
              engine: 'agent',
              eventRecorded: true,
              eventType: customerEvent.type,
            },
          };
        }
      }

      // 3b. Agent Mode: autonomous AI-led turn with multi-round tool execution and streaming

      // Agent mode is the only mode: every turn is an autonomous, tool-using agent turn.
      if (!workspace) {
        workspace = await this.workspaceRepo.getOrCreate(
          tenantId,
          envId,
          workspaceId,
          'unassigned',
          'initial',
          undefined,
          release.manifest.version || release.manifest.packId,
          this.createWorkspacePins(release)
        );
      }

      const turnDeadlineMs =
        Number(
          (release.conversationPolicy as any)?.turnDeadlineMs ||
          (release.conversationPolicy as any)?.timeoutMs ||
          (release.conversationPolicy as any)?.deadlineMs ||
          (release.conversationPolicy as any)?.escalationThresholds?.turnTimeoutMs ||
          (release.extensions?.agentMode as any)?.timeoutMs ||
          (release.extensions?.agentMode as any)?.turnDeadlineMs
        ) || 20_000;

      let agentStreamedText = '';
      let agentCancelled = false;
      const streamingEnabled = release.extensions?.dialoguePolicy?.streaming !== false;
      const agentTimingSink = (event: string, data: any) => {
        if (agentCancelled) return;
        if (event === 'token') {
          const chunk = data?.delta !== undefined ? data.delta : (data?.token || '');
          agentStreamedText += chunk;
          if (!streamingEnabled) return;
        }
        timingSink(event, data);
      };

      let timeoutHandle: any;
      const abortController = new AbortController();
      const deadlinePromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const err = new Error(`Agent mode turn deadline exceeded (${turnDeadlineMs}ms)`);
          abortController.abort(err);
          reject(err);
        }, turnDeadlineMs);
      });

      try {
        const agentLoop = new AgentTurnLoop();
        const catalogSearchHandler =
          (this.capabilityGateway?.getNativeHandler?.('catalog.search') as CatalogSearchHandler) ||
          new CatalogSearchHandler();
        const branchStockHandler =
          (this.capabilityGateway?.getNativeHandler?.('branch.stock_check') as BranchStockCheckHandler) ||
          new BranchStockCheckHandler();
        const outcome = await Promise.race([
          agentLoop.execute({
            command,
            release,
            workspace,
            modelGateway: this.modelGateway,
            catalogSearchHandler,
            branchStockHandler,
            knowledgeSearchHandler: (this.capabilityGateway?.getNativeHandler?.('knowledge.search') as KnowledgeSearchHandler) || new KnowledgeSearchHandler(),
            knowledgeControlPlane: this.knowledgeControlPlane,
            capabilityGateway: this.capabilityGateway,
            iqClient: this.scopedPorts?.iqClient,
            retailIqIdentity: this.scopedPorts ? this.scopedPorts.retailIqIdentity : new MongoRetailIqIdentityPort(async () => {
              const uri = process.env.MONGODB_URI, database = process.env.MONGODB_DB_NAME;
              if (!uri || !database) throw new Error('Explicit runtime identity storage is required.');
              return (await connectToDatabase(uri, database)).db;
            }),
            inMemoryQuotes: this.scopedPorts?.commerceStores?.quotes,
            inMemoryCarts: this.scopedPorts?.commerceStores?.carts,
            inMemoryCommerceProducts: this.scopedPorts?.commerceStores?.products,
            approvalService: this.approvalService,
            executionRepo: this.executionRepo,
            transcriptStore: this.transcriptStore,
            knowledgeGapRepo: this.knowledgeGapRepo,
            productGuideRepo: this.productGuideRepo,
            contentPageRepo: this.contentPageRepo,
            formSubmissionRepo: this.formSubmissionRepo,
            companyDirectory: this.companyDirectory,
            sink: agentTimingSink,
            timeoutMs: turnDeadlineMs,
            signal: abortController.signal,
          }),
          deadlinePromise,
        ]);

        clearTimeout(timeoutHandle);

        await this.commitWorkspace(
          workspace,
          turnId,
          envId,
          tenantId,
          workspaceId,
          outcome.turnResult.decision.type,
          command.correlationId,
          {
            customerMessage: command.message || (command as any).userInput || (command as any).text || '',
            assistantReply:
              (typeof outcome.turnResult.assistantMessage === 'string'
                ? outcome.turnResult.assistantMessage
                : (outcome.turnResult.assistantMessage as any)?.content) ||
              (outcome.turnResult as any).message ||
              '',
            turnStartTime,
            sessionId: command.sessionId,
            agentId: (outcome.turnResult as any).metadata?.agentId || (outcome as any).agent?.agentId,
            release,
            thread: (outcome as any).thread,
          }
        );
        if (!streamingEnabled && outcome.turnResult.assistantMessage) {
          const message = typeof outcome.turnResult.assistantMessage === 'string' ? outcome.turnResult.assistantMessage : (outcome.turnResult.assistantMessage as any).content;
          if (message) timingSink('token', { delta: message, token: message });
        }
        this.streamCommittedFinalEvents(
          command,
          outcome.turnResult,
          outcome.turnResult.executedCapabilities || [],
          timingSink,
          outcome.turnResult.assistantMessage
        );
        this.recordTurnTiming(
          outcome.turnResult,
          turnStartTime,
          timeToFirstEventMs,
          timeToFirstTextMs,
          { latencyMs: outcome.durationMs, usage: outcome.tokens },
          undefined,
          0,
          0,
          command
        );
        return outcome.turnResult;
      } catch (agentErr: any) {
        abortController.abort(agentErr);
        agentCancelled = true;
        clearTimeout(timeoutHandle);
        console.warn(
          `[AgentMode] Autonomous turn failed (${agentErr?.message || agentErr}). Returning a failure response; no support notification is confirmed.`
        );

        // No handoff capability ran in this catch path. A configured handoff promise is not a notification receipt.
        const politeMessage = agentLoopDefaults.modelUnavailableMessage;

        if (agentStreamedText.length > 0) {
          timingSink('token', { replace: politeMessage, delta: politeMessage });
        } else {
          timingSink('token', { delta: politeMessage });
        }

        appendHistory(
          workspace,
          [
            { role: 'customer', content: command.message || (command as any).userInput || (command as any).text || '', turnId },
            { role: 'assistant', content: politeMessage, turnId },
          ],
          release.extensions?.dialoguePolicy?.history
        );

        const failureDecision: Decision = {
          decisionId: `dec_${Date.now()}`,
          type: 'fail',
          payload: { reason: agentErr?.message || 'Agent mode failure' },
          reason: agentErr?.message || 'Agent mode failure',
          createdAt: new Date().toISOString(),
        };

        const failureResult: TurnResult = {
          workspace,
          decision: failureDecision,
          assistantMessage: politeMessage,
          uiInstructions: [],
          executedCapabilities: [],
          trace: {
            stage: workspace.currentStage || 'unassigned',
            transitions: [],
            decisionsMade: [failureDecision],
            agentMode: true,
            fallbackToRuleEngine: false,
            resilienceHandled: true,
            error: agentErr?.message || String(agentErr),
          } as any,
        };

        await this.commitWorkspace(
          workspace,
          turnId,
          envId,
          tenantId,
          workspaceId,
          failureDecision.type,
          command.correlationId
        );

        this.streamCommittedFinalEvents(
          command,
          failureResult,
          failureResult.executedCapabilities || [],
          timingSink,
          politeMessage
        );

        this.recordTurnTiming(
          failureResult,
          turnStartTime,
          timeToFirstEventMs,
          timeToFirstTextMs,
          { latencyMs: Date.now() - turnStartTime, usage: { prompt: 0, completion: 0, total: 0 } },
          undefined,
          0,
          0,
          command
        );

        return failureResult;
      } finally {
        clearTimeout(timeoutHandle);
      }

    } catch (err: any) {
      sink('error', {
        message: err.message || 'Error executing turn stream',
        code: err.code,
        turnId: err.turnId,
      });
      throw err;
    }
  }

  /**
   * Records structured timing and token metrics on the turn trace and emits a structured JSON log.
   */
  private recordTurnTiming(
    turnResult: TurnResult,
    turnStartTime: number,
    timeToFirstEventMs: number | null,
    timeToFirstTextMs: number | null,
    interpretation?: { latencyMs?: number; usage?: any },
    groundedResponse?: { latencyMs?: number; usage?: any },
    retrievalMs: number = 0,
    phraseMs: number = 0,
    command?: { tenantId?: string; turnId?: string }
  ): TurnTiming {
    const totalMs = Date.now() - turnStartTime;
    const interpretMs = interpretation?.latencyMs || 0;
    const responseMs = groundedResponse?.latencyMs || 0;
    let modelCalls = 0;
    if (interpretMs > 0) modelCalls++;
    if (responseMs > 0) modelCalls++;
    if (phraseMs > 0) modelCalls++;

    const promptTokens =
      (interpretation?.usage?.promptTokens || (interpretation?.usage as any)?.prompt || 0) +
      (groundedResponse?.usage?.promptTokens || (groundedResponse?.usage as any)?.prompt || 0);
    const completionTokens =
      (interpretation?.usage?.completionTokens || (interpretation?.usage as any)?.completion || 0) +
      (groundedResponse?.usage?.completionTokens || (groundedResponse?.usage as any)?.completion || 0);
    const totalTokens =
      (interpretation?.usage?.totalTokens || (interpretation?.usage as any)?.total || 0) +
      (groundedResponse?.usage?.totalTokens || (groundedResponse?.usage as any)?.total || 0);

    const timing: TurnTiming = {
      tenantId: command?.tenantId,
      turnId: command?.turnId,
      timeToFirstEventMs,
      timeToFirstTextMs: timeToFirstTextMs ?? (turnResult.assistantMessage ? totalMs : null),
      interpretMs,
      responseMs,
      phraseMs,
      retrievalMs,
      totalMs,
      modelCalls,
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: totalTokens,
      },
    };

    if (turnResult.trace) {
      (turnResult.trace as any).timing = timing;
    }
    console.log(JSON.stringify({
      event: 'turn.timing',
      tenantId: command?.tenantId,
      turnId: command?.turnId,
      ...timing,
    }));
    return timing;
  }

  /**
   * Commits workspace state and outbox events atomically.
   */
  private async commitWorkspace(
    workspace: any,
    turnId: string | undefined,
    envId: EnvironmentId,
    tenantId: string,
    workspaceId: string,
    decisionType: string,
    correlationId: string | undefined,
    transcriptMeta?: {
      customerMessage?: string;
      assistantReply?: string;
      turnStartTime?: number;
      sessionId?: string;
      agentId?: string;
      release?: BusinessPackRelease;
      thread?: any[];
    }
  ): Promise<void> {
    workspace.lastProcessedTurnId = turnId;

    const saveDurableTranscript = async (s?: any) => {
      if (turnId && transcriptMeta && (transcriptMeta.customerMessage || transcriptMeta.assistantReply)) {
        const retentionDays =
          (transcriptMeta.release?.conversationPolicy as any)?.retentionDays ||
          (transcriptMeta.release as any)?.retentionDays;
        await this.transcriptStore.saveTurn(
          {
            tenantId,
            environmentId: envId,
            workspaceId,
            turnId,
            sessionId: transcriptMeta.sessionId,
            customerMessage: transcriptMeta.customerMessage || '',
            assistantReply: transcriptMeta.assistantReply || '',
            agentId: transcriptMeta.agentId,
            ...(transcriptMeta.thread ? { thread: transcriptMeta.thread } : {}),
            timestamps: {
              receivedAt: transcriptMeta.turnStartTime
                ? new Date(transcriptMeta.turnStartTime).toISOString()
                : new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          },
          retentionDays,
          s
        );
      }
    };

    const isProdOrStaging =
      envId === 'production' ||
      envId === 'staging' ||
      process.env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'staging' ||
      process.env.APP_ENV === 'production' ||
      process.env.APP_ENV === 'staging';

    const uri = process.env.MONGODB_URI;
    const isExplicitMemoryConfigured = Boolean(
      (this.workspaceRepo as any)?.isExplicitMemory ||
      (this.workspaceRepo as any)?.store?.explicitMemory ||
      (this.outboxRepo as any)?.isExplicitMemory ||
      (this.outboxRepo as any)?.explicitMemory
    );
    if (isProdOrStaging && !uri && !isExplicitMemoryConfigured && process.env.ALLOW_IN_MEMORY_WORKSPACES !== 'true') {
      throw new Error(`[TurnApplicationService] MONGODB_URI is required for atomic transactions in ${envId}`);
    }

    if (uri && !isExplicitMemoryConfigured) {
      const { client } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const topologyType = (client as any)?.topology?.description?.type;
      const setName = (client as any)?.topology?.description?.setName;
      const isStandalone = !client?.startSession || (topologyType === 'Single' && !setName);

      if (isStandalone) {
        if (isProdOrStaging) {
          throw new Error(
            `[TurnApplicationService] Standalone MongoDB does not support transactions; multi-document transactions are required in ${envId}`
          );
        }
        await this.workspaceRepo.save(workspace);
        await saveDurableTranscript();
        await this.outboxRepo.enqueueEvent(
          tenantId,
          envId,
          'journey.turn_completed',
          {
            workspaceId,
            stage: workspace.currentStage,
            decisionType,
          },
          correlationId
        );
        return;
      }

      // Transactions are supported
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await this.workspaceRepo.save(workspace, session);
          await saveDurableTranscript(session);
          await this.outboxRepo.enqueueEvent(
            tenantId,
            envId,
            'journey.turn_completed',
            {
              workspaceId,
              stage: workspace.currentStage,
              decisionType,
            },
            correlationId,
            session
          );
        });
        return;
      } finally {
        await session.endSession();
      }
    }

    // In-memory or mock repo in dev/test (no URI configured)
    await this.workspaceRepo.save(workspace);
    await saveDurableTranscript();
    await this.outboxRepo.enqueueEvent(
      tenantId,
      envId,
      'journey.turn_completed',
      {
        workspaceId,
        stage: workspace.currentStage,
        decisionType,
      },
      correlationId
    );
  }

  /**
   * Only after successful commit emit final assistant response, capability results, confirmed UI actions, data and exactly one done.
   */
  private streamCommittedFinalEvents(
    command: TurnCommand,
    turnResult: TurnResult,
    executedCapabilities: any[],
    sink: (event: string, data: any) => void,
    streamedText?: string
  ): void {
    // 1. capability: executed capabilities
    for (const cap of executedCapabilities) {
      sink('capability', cap);
    }

    // 2. uiAction: presentCard envelopes for confirmed UI instructions
    for (const inst of turnResult.uiInstructions || []) {
      sink('uiAction', {
        name: 'presentCard',
        arguments: {
          card: {
            id: inst.actionId || `${inst.component}-${Date.now()}`,
            cardType: inst.component,
            state: inst.props,
          },
        },
        card: {
          cardType: inst.component,
          state: inst.props,
        },
      });
    }

    // 3. token: honest model message delivery of the final confirmed assistant response
    const text = turnResult.assistantMessage || '';
    if (text) {
      if (!streamedText) {
        sink('token', { token: text, delta: text });
      } else if (text !== streamedText) {
        if (text.startsWith(streamedText)) {
          const remaining = text.slice(streamedText.length);
          if (remaining) {
            sink('token', { token: remaining, delta: remaining });
          }
        } else {
          sink('token', { token: text, delta: '', replace: text });
        }
      }
    }

    const engine = turnResult.trace?.engine || (turnResult.trace?.agentMode ? 'agent' : 'canonical');
    const agentId = turnResult.trace?.agentId || (turnResult as any).metadata?.agentId;
    if (turnResult.trace && !turnResult.trace.engine) {
      (turnResult.trace as any).engine = engine;
    }
    if (turnResult.trace && !turnResult.trace.agentId && agentId) {
      (turnResult.trace as any).agentId = agentId;
    }

    // The ids this turn's two messages are kept under in the conversation thread, so the chat can say "continue from here" (try again,
    // edit an earlier message) by naming one as the parent of the next message.
    const messageIds = command.turnId ? { customer: customerMessageId(command.turnId), assistant: assistantMessageId(command.turnId) } : undefined;

    // 4. data: state, decision, and trace
    sink('data', {
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      decision: turnResult.decision,
      trace: turnResult.trace,
      engine,
      agentId,
      messageIds,
    });

    // 5. done: final outcome — exactly one done event
    sink('done', {
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      decision: turnResult.decision,
      trace: turnResult.trace,
      engine,
      agentId,
      messageIds,
      response: text,
      assistantMessage: text,
      message: { role: 'assistant', content: text },
    });
  }
}
