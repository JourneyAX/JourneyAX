import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  Decision,
  EnvironmentId,
} from '@journeyax/journey-core';
import { ExecutionContext } from '@journeyax/capability-sdk';
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
import { TurnInterpreter } from '../turn/interpret-event';
import { FactReducer } from '../turn/fact-reducer';

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
    private readonly interpreter: TurnInterpreter = new TurnInterpreter(),
    private readonly factReducer: FactReducer = new FactReducer()
  ) {
    if (this.approvalService && !this.approvalService.getOutboxRepo()) {
      this.approvalService.setOutboxRepo(this.outboxRepo);
    }
  }

  async executeTurn(command: TurnCommand): Promise<TurnResult> {
    const tenantId = command.tenantId;
    const envId: EnvironmentId = command.environmentId || 'production';
    const workspaceId = command.workspaceId || command.sessionId;

    // 1. Authoritative Business Pack resolution
    const release = await this.packRepo.loadActivePack(tenantId, envId);
    const primaryJourney = release.journeys[0];
    const initialStage = primaryJourney?.initialStage || 'entry';

    // 2. Load or initialize Workspace State
    let workspace = await this.workspaceRepo.getOrCreate(
      tenantId,
      envId,
      workspaceId,
      primaryJourney?.journeyId || 'default',
      initialStage,
      undefined,
      release.manifest.version || release.manifest.packId
    );

    // 3. Extract and reduce conversational facts
    const interpretation = await this.interpreter.interpret(command, release, workspace);
    workspace = this.factReducer.apply(workspace, interpretation);

    // 4. Resolve Stage Decision
    let decision = this.journeyResolver.decide(release, workspace);
    let outcome: any = null;
    let pendingApproval: any = null;
    let execResponse: any = null;
    let executedToolId: string | null = null;

    // 5. If stage demands capability execution
    if (decision.type === 'invoke_capability' && decision.targetCapability) {
      executedToolId = decision.targetCapability;
      const toolId = executedToolId;
      const idempotencyKey = command.idempotencyKey || `${command.correlationId}:${toolId}`;

      // Pre-dispatch idempotency check
      const existingExec = await this.executionRepo.findExecution(
        tenantId,
        envId,
        workspaceId,
        toolId,
        idempotencyKey
      );

      if (existingExec && existingExec.status === 'completed') {
        outcome = existingExec.outputPayload;
        execResponse = {
          toolId,
          status: 'success',
          output: outcome,
          durationMs: existingExec.durationMs || 0,
          idempotentReplay: true,
          provenance: {
            executorType: 'idempotency-cache',
            executedAt: existingExec.executedAt ? new Date(existingExec.executedAt).toISOString() : new Date().toISOString(),
            correlationId: command.correlationId,
          },
        };

        if (outcome && typeof outcome === 'object' && outcome.facts) {
          workspace = this.factReducer.apply(workspace, outcome.facts);
        }
      } else {
        const ctx: ExecutionContext = {
          tenantId,
          environmentId: envId,
          workspaceId,
          sessionId: command.sessionId || workspaceId,
          principalId: command.principalId || 'customer',
          principalRole: command.principalRole || 'customer',
          stageId: workspace.currentStage,
          packVersionId: release.manifest.version || release.manifest.packId,
          correlationId: command.correlationId,
        };

        const execRecord = {
          tenantId,
          environmentId: envId,
          workspaceId,
          correlationId: command.correlationId,
          toolId,
          idempotencyKey,
          status: 'started' as const,
          inputPayload: decision.payload,
          executedBy: command.principalId,
          executedAt: new Date(),
        };

        await this.executionRepo.recordExecution(execRecord);

        execResponse = await this.capabilityGateway.executeCapability(
          release,
          toolId,
          decision.payload || {},
          ctx
        );

        if (execResponse.status === 'requires_approval') {
          pendingApproval = await this.approvalService.createPending(
            toolId,
            decision.payload,
            ctx
          );
          decision = {
            decisionId: `dec_${Date.now()}`,
            type: 'requires_approval',
            payload: {
              approvalRequestId: pendingApproval.approvalRequestId,
              toolId,
              displayName: toolId,
            },
            reason: execResponse.error || 'Requires confirmation',
            createdAt: new Date().toISOString(),
          };

          await this.executionRepo.recordExecution({
            ...execRecord,
            status: 'requires_approval',
          });
        } else if (execResponse.status === 'success') {
          outcome = execResponse.output;
          await this.executionRepo.recordExecution({
            ...execRecord,
            status: 'completed',
            outputPayload: outcome,
            durationMs: execResponse.durationMs,
          });

          // Merge outcome facts if capability returned structured facts
          if (outcome && typeof outcome === 'object' && outcome.facts) {
            workspace = this.factReducer.apply(workspace, outcome.facts);
          }
        } else {
          await this.executionRepo.recordExecution({
            ...execRecord,
            status: 'failed',
            error: execResponse.error,
            durationMs: execResponse.durationMs,
          });
        }
      }
    }

    // 6. Handle explicit stage transitions
    if (decision.type === 'transition_stage' && decision.targetStage) {
      workspace = {
        ...workspace,
        currentStage: decision.targetStage,
        updatedAt: new Date(),
      };
      // Re-evaluate newly entered stage
      decision = this.journeyResolver.decide(release, workspace);
    }

    // 7. Compose presentation & card envelope
    let resolvedAgentInfo: any = null;
    if (release.agents && release.agents.length > 0) {
      try {
        const resolved = this.agentRouter.resolveAgent(release, workspace);
        resolvedAgentInfo = {
          agentId: resolved.agent.agentId,
          name: resolved.agent.name,
          modelPolicyRef: resolved.modelPolicyRef,
        };
      } catch {}
    }

    const turnResult = this.presentationPort.compose(
      { valid: true, outcome },
      decision,
      workspace,
      release
    );

    if (release.modelPolicy && turnResult.trace) {
      try {
        const route = this.modelGateway.router.resolveModel('fast_intent', release, {
          policyRef: resolvedAgentInfo?.modelPolicyRef,
        });
        turnResult.trace.modelRoute = {
          policyId: route.policyId,
          provider: route.provider,
          model: route.model,
          dataResidency: route.dataResidency,
        };
      } catch (err: any) {
        // Fallback or warning if credentials unconfigured in test
      }
    }

    if (executedToolId && execResponse) {
      turnResult.executedCapabilities = [
        {
          toolId: executedToolId,
          status: execResponse.status,
          output: execResponse.output,
          error: execResponse.error,
          approvalRequestId: pendingApproval?.approvalRequestId || execResponse.approvalRequestId,
        },
      ];
    }

    // 8. Commit updated workspace state and outbox events atomically
    workspace.lastProcessedTurnId = command.idempotencyKey || command.correlationId;

    const isProdOrStaging =
      envId === 'production' ||
      envId === 'staging' ||
      process.env.NODE_ENV === 'production' ||
      process.env.NODE_ENV === 'staging' ||
      process.env.APP_ENV === 'production' ||
      process.env.APP_ENV === 'staging';

    const uri = process.env.MONGODB_URI;
    if (isProdOrStaging && !uri) {
      throw new Error(`[TurnApplicationService] MONGODB_URI is required for atomic transactions in ${envId}`);
    }

    if (uri) {
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
        // Positively identified local standalone-Mongo before work starts in dev/test only
        await this.workspaceRepo.save(workspace);
        await this.outboxRepo.enqueueEvent(
          tenantId,
          envId,
          'journey.turn_completed',
          {
            workspaceId,
            stage: workspace.currentStage,
            decisionType: decision.type,
          },
          command.correlationId
        );
        return turnResult;
      }

      // Transactions are supported (Replica Set / Sharded / session capable)
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await this.workspaceRepo.save(workspace, session);
          await this.outboxRepo.enqueueEvent(
            tenantId,
            envId,
            'journey.turn_completed',
            {
              workspaceId,
              stage: workspace.currentStage,
              decisionType: decision.type,
            },
            command.correlationId,
            session
          );
        });
        return turnResult;
      } catch (txErr: any) {
        // NEVER retry sequentially after arbitrary transaction / commit error
        // Re-throw to prevent duplicating workspace state or outbox events
        throw txErr;
      } finally {
        await session.endSession();
      }
    }

    // In-memory or mock repo in dev/test (no URI configured)
    await this.workspaceRepo.save(workspace);
    await this.outboxRepo.enqueueEvent(
      tenantId,
      envId,
      'journey.turn_completed',
      {
        workspaceId,
        stage: workspace.currentStage,
        decisionType: decision.type,
      },
      command.correlationId
    );

    return turnResult;
  }
}
