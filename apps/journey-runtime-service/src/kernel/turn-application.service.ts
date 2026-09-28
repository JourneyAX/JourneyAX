import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  Decision,
  EnvironmentId,
  DuplicateTurnError,
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
import { OutcomeValidator } from '../turn/validate-outcome';

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
    private readonly interpreter: TurnInterpreter = new TurnInterpreter(modelGateway),
    private readonly factReducer: FactReducer = new FactReducer(),
    public readonly outcomeValidator: OutcomeValidator = new OutcomeValidator()
  ) {
    if (this.approvalService && !this.approvalService.getOutboxRepo()) {
      this.approvalService.setOutboxRepo(this.outboxRepo);
    }
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
  async executeTurn(command: TurnCommand, preloadedRelease?: any): Promise<TurnResult> {
    const tenantId = command.tenantId;
    const envId: EnvironmentId = command.environmentId || 'production';
    const workspaceId = command.workspaceId || command.sessionId;
    const turnId = command.turnId;

    // 1. Authoritative Business Pack resolution
    // If a pre-validated release was passed by the cutover gate, use it directly.
    // This eliminates the double loadActivePack call and guarantees the exact
    // version and checksum that was validated is what executes — no TOCTOU window.
    const release = preloadedRelease ?? await this.packRepo.loadActivePack(tenantId, envId);


    // 2. Load existing Workspace State (if present)
    let workspace =
      typeof this.workspaceRepo?.load === 'function'
        ? await this.workspaceRepo.load(tenantId, envId, workspaceId)
        : null;

    // 2a. Turn Replay Rejection — Duplicate turnId is rejected unconditionally regardless of tool execution!
    if (turnId && workspace && workspace.lastProcessedTurnId === turnId) {
      throw new DuplicateTurnError(turnId);
    }

    // 3. Extract and reduce conversational facts through model-gateway & schema validation
    const interpretation = await this.interpreter.interpret(command, release, workspace || ({} as any));

    // 2b. Goal/Policy-based Journey Selection (strictly typed, zero positional fallback)
    if (!this.journeyResolver || typeof this.journeyResolver.resolveJourneyResolution !== 'function') {
      const decision: Decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'JourneyResolver unavailable' },
        reason: 'Journey resolution component is unavailable',
        createdAt: new Date().toISOString(),
      };
      return this.presentationPort.compose({ valid: false, notes: decision.reason }, decision, workspace || ({} as any), release);
    }

    const resolution = this.journeyResolver.resolveJourneyResolution(
      release,
      workspace || ({} as any),
      command,
      interpretation
    );

    if (resolution.status === 'ambiguous') {
      const decision = this.journeyResolver.decide(release, workspace || ({} as any), command, interpretation);
      return this.presentationPort.compose({ valid: true }, decision, workspace || ({} as any), release);
    }

    if (resolution.status !== 'resolved') {
      const decision: Decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'No active journey matched' },
        reason: (resolution as any).reason || `No matching journey found for tenant='${tenantId}' goal/intent`,
        createdAt: new Date().toISOString(),
      };
      return this.presentationPort.compose({ valid: false, notes: decision.reason }, decision, workspace || ({} as any), release);
    }

    const activeJourney = resolution.journey;
    if (!activeJourney) {
      throw new Error(`[TurnApplicationService] No matching journey found for tenant='${tenantId}' goal/intent`);
    }

    if (!workspace) {
      workspace = await this.workspaceRepo.getOrCreate(
        tenantId,
        envId,
        workspaceId,
        activeJourney.journeyId,
        activeJourney.initialStage,
        undefined,
        release.manifest.version || release.manifest.packId
      );
    }

    // Ensure journey, goal, openQuestions, decisions initialized
    workspace.journeyId = activeJourney.journeyId;
    if (activeJourney.goals && activeJourney.goals.length > 0 && !workspace.goal) {
      workspace.goal = activeJourney.goals[0];
    }
    if (!workspace.currentStage) {
      workspace.currentStage = activeJourney.initialStage;
    }
    if (!workspace.openQuestions) {
      workspace.openQuestions = [];
    }
    if (!workspace.decisions) {
      workspace.decisions = [];
    }

    // Apply interpreted candidate facts
    workspace = this.factReducer.apply(workspace, interpretation.candidateFacts);

    // Durable answers: remove answered questions from openQuestions
    if (workspace.openQuestions.length > 0) {
      workspace.openQuestions = workspace.openQuestions.filter((q) => {
        return workspace.facts[q]?.value === undefined;
      });
    }

    // 4. Resolve Stage Decision & Handle Stage Transitions
    let decision = this.journeyResolver.decide(release, workspace, command, interpretation);
    let outcome: any = null;
    let pendingApproval: any = null;
    let execResponse: any = null;
    let executedToolId: string | null = null;

    // Check if decision is a stage transition
    if (decision.type === 'transition_stage' && decision.targetStage) {
      workspace.decisions.push({
        ...decision,
        executedAt: new Date().toISOString(),
        outcomeStatus: 'success',
      });
      workspace = {
        ...workspace,
        currentStage: decision.targetStage,
        updatedAt: new Date(),
      };
      // Re-evaluate newly entered stage in the SAME turn!
      decision = this.journeyResolver.decide(release, workspace, command, interpretation);
    }

    // 5. Capability Execution (including in newly entered stage in the same turn)
    if (decision.type === 'invoke_capability' && decision.targetCapability) {
      executedToolId = decision.targetCapability;
      const toolId = executedToolId;
      const toolIdempotencyKey = command.idempotencyKey || `${command.correlationId}:${toolId}`;

      // Pre-dispatch tool idempotency check
      const existingExec = await this.executionRepo.findExecution(
        tenantId,
        envId,
        workspaceId,
        toolId,
        toolIdempotencyKey
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
          idempotencyKey: toolIdempotencyKey,
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

    // 6. OutcomeValidator before transition/presentation (validates capability execution output)
    const validatedOutcome =
      executedToolId || outcome !== null
        ? this.outcomeValidator.validate(decision, outcome, release, workspace)
        : { valid: true, outcome: null, appliedRules: [] };

    if (!validatedOutcome.valid && decision.type !== 'ask_fact' && decision.type !== 'requires_approval') {
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'fail',
        payload: { error: validatedOutcome.notes, violations: validatedOutcome.appliedRules },
        reason: validatedOutcome.notes || 'Outcome failed business validation rules',
        createdAt: new Date().toISOString(),
      };
    }

    // 7. Update OpenQuestions and Decision Records
    if (decision.type === 'ask_fact' && decision.payload.targetFact) {
      workspace.openQuestions = [decision.payload.targetFact];
    }
    workspace.decisions.push({
      ...decision,
      executedAt: new Date().toISOString(),
      outcomeStatus: validatedOutcome.valid ? 'success' : 'failure',
    });

    // 8. Compose presentation & card envelope
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
      validatedOutcome,
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

    // 9. Commit updated workspace state and outbox events atomically
    workspace.lastProcessedTurnId = turnId;

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

      // Transactions are supported
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
