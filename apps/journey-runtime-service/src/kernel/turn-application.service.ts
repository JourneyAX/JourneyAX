import { createHash } from 'node:crypto';
import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  Decision,
  EnvironmentId,
  DuplicateTurnError,
  Transition,
  FactsMap,
} from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';
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
function extractValueByJsonPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  if (path === 'true') return true;
  if (path === 'false') return false;
  if (!isNaN(Number(path))) return Number(path);

  const compMatch = path.match(/^([a-zA-Z0-9_.]+)\s*(>|<|>=|<=|==|===|!=|!==)\s*(.+)$/);
  if (compMatch) {
    const [, subPath, op, rawRight] = compMatch;
    const leftVal = extractValueByJsonPath(obj, subPath);
    let rightVal: any = rawRight.trim();
    if (!isNaN(Number(rightVal))) rightVal = Number(rightVal);
    else if (rightVal === 'true') rightVal = true;
    else if (rightVal === 'false') rightVal = false;
    else if (
      (rightVal.startsWith('"') && rightVal.endsWith('"')) ||
      (rightVal.startsWith("'") && rightVal.endsWith("'"))
    ) {
      rightVal = rightVal.slice(1, -1);
    }
    switch (op) {
      case '>': return leftVal > rightVal;
      case '<': return leftVal < rightVal;
      case '>=': return leftVal >= rightVal;
      case '<=': return leftVal <= rightVal;
      case '==': return leftVal == rightVal;
      case '===': return leftVal === rightVal;
      case '!=': return leftVal != rightVal;
      case '!==': return leftVal !== rightVal;
    }
  }

  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    if (Array.isArray(curr) && !isNaN(Number(part))) {
      curr = curr[Number(part)];
    } else if (typeof curr === 'object' && part in curr) {
      curr = curr[part];
    } else {
      return undefined;
    }
  }
  return curr;
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
    try {
      const tenantId = command.tenantId;
      const envId: EnvironmentId = command.environmentId || 'production';
      const workspaceId = command.workspaceId || command.sessionId;
      const turnId = command.turnId;

      // 1. Forward session event at start of streaming boundary
      sink('session', { sessionId: command.sessionId || workspaceId });

      // 2. Authoritative Business Pack resolution
      // If a pre-validated release was passed by the cutover gate, use it directly.
      // This eliminates the double loadActivePack call and guarantees the exact
      // version and checksum that was validated is what executes — no TOCTOU window.
      const release = preloadedRelease ?? await this.packRepo.loadActivePack(tenantId, envId);

      // 3. Load existing Workspace State (if present)
      let workspace =
        typeof this.workspaceRepo?.load === 'function'
          ? await this.workspaceRepo.load(tenantId, envId, workspaceId)
          : null;

      // 3a. Turn Replay Rejection — Duplicate turnId is rejected unconditionally regardless of tool execution!
      if (turnId && workspace && workspace.lastProcessedTurnId === turnId) {
        throw new DuplicateTurnError(turnId);
      }

      // 4. Extract and reduce conversational facts through model-gateway & schema validation
      const interpretation = await this.interpreter.interpret(command, release, workspace || ({} as any));

      // 4a. Goal/Policy-based Journey Selection (strictly typed, zero positional fallback)
      if (!this.journeyResolver || typeof this.journeyResolver.resolveJourneyResolution !== 'function') {
        const decision: Decision = {
          decisionId: `dec_${Date.now()}`,
          type: 'handoff',
          payload: { error: 'JourneyResolver unavailable' },
          reason: 'Journey resolution component is unavailable',
          createdAt: new Date().toISOString(),
        };
        const turnResult = this.presentationPort.compose({ valid: false, notes: decision.reason }, decision, workspace || ({} as any), release);
        sink('trace', { currentStage: workspace?.currentStage || 'initial', transitions: [] });
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
      }

      const resolution = this.journeyResolver.resolveJourneyResolution(
        release,
        workspace || ({} as any),
        command,
        interpretation
      );

      if (resolution.status === 'ambiguous') {
        if (!workspace) {
          workspace = await this.workspaceRepo.getOrCreate(
            tenantId,
            envId,
            workspaceId,
            'unassigned',
            'initial',
            undefined,
            release.manifest.version || release.manifest.packId
          );
        }
        // Preserve candidate facts already captured
        workspace = this.factReducer.apply(workspace, interpretation.candidateFacts);
        const decision = this.journeyResolver.decide(release, workspace, command, interpretation);
        if (decision.type === 'ask_fact') {
          const qIds =
            Array.isArray(decision.payload?.questions) && decision.payload.questions.length > 0
              ? decision.payload.questions.map((q: any) => q.id || q.key)
              : decision.payload?.targetFact
              ? [decision.payload.targetFact]
              : [];
          workspace.openQuestions = qIds;
        }
        workspace.decisions.push({
          ...decision,
          executedAt: new Date().toISOString(),
          outcomeStatus: 'pending',
        });
        workspace.lastProcessedTurnId = turnId;

        const turnResult = this.presentationPort.compose({ valid: true }, decision, workspace, release);
        if (turnResult.trace) {
          turnResult.trace.transitions = [];
          if ((interpretation as any)?.modelRoute) {
            turnResult.trace.modelRoute = (interpretation as any).modelRoute;
          }
          if (interpretation.failure) {
            (turnResult.trace as any).errors = [interpretation.failure];
          }
        }
        sink('trace', {
          currentStage: workspace.currentStage,
          transitions: [],
        });
        // Commit atomically before final success/confirmation
        await this.commitWorkspace(workspace, turnId, envId, tenantId, workspaceId, decision.type, command.correlationId);
        // Only after commit emit final confirmed events
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
      }

      if (resolution.status !== 'resolved') {
        if (!workspace) {
          workspace = await this.workspaceRepo.getOrCreate(
            tenantId,
            envId,
            workspaceId,
            'unassigned',
            'initial',
            undefined,
            release.manifest.version || release.manifest.packId
          );
        }
        const decision = this.journeyResolver.decide(release, workspace, command, interpretation);
        const turnResult = this.presentationPort.compose({ valid: false, notes: decision.reason }, decision, workspace, release);
        if (turnResult.trace) {
          turnResult.trace.transitions = [];
          if ((interpretation as any)?.modelRoute) {
            turnResult.trace.modelRoute = (interpretation as any).modelRoute;
          }
        }
        sink('trace', {
          currentStage: workspace?.currentStage || 'initial',
          transitions: [],
        });
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
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

    const transitions: Transition[] = [];
    let transitionCount = 0;
    const MAX_TRANSITIONS = 5;

    // 4. Resolve Stage Decision & Handle Stage Transitions (with loop cap)
    let decision = this.journeyResolver.decide(release, workspace, command, interpretation);

    while (decision.type === 'transition_stage' && decision.targetStage && transitionCount < MAX_TRANSITIONS) {
      transitionCount++;
      const fromStage = workspace.currentStage;
      const toStage = decision.targetStage;
      transitions.push({
        fromStage,
        toStage,
        trigger: 'stage_exit_condition',
        reason: decision.reason,
        evaluatedAt: new Date().toISOString(),
      });
      workspace.decisions.push({
        ...decision,
        executedAt: new Date().toISOString(),
        outcomeStatus: 'success',
      });
      workspace = {
        ...workspace,
        currentStage: toStage,
        updatedAt: new Date(),
      };
      decision = this.journeyResolver.decide(release, workspace, command, interpretation);
    }

    // Emit stage/journey trace event
    sink('trace', {
      currentStage: workspace.currentStage,
      journeyId: activeJourney.journeyId,
      transitions,
    });

    let outcome: any = null;
    let pendingApproval: any = null;
    let execResponse: any = null;
    let executedToolId: string | null = null;

    const executedCapabilities: any[] = [];
    let capabilityCount = 0;
    const MAX_CAPABILITIES = 5;

    // 5. Capability Execution (including in newly entered stage in the same turn)
    while (decision.type === 'invoke_capability' && decision.targetCapability && capabilityCount < MAX_CAPABILITIES) {
      capabilityCount++;
      executedToolId = decision.targetCapability;
      const toolId = executedToolId;

      // 5a. Retrieval Gate: Gated execution for catalogue/search/technical-documents
      // Do not run catalogue search, vector search or technical-document response generation until
      // the journey's configured minimum discovery facts are satisfied.
      const isRetrievalCapability = [
        'catalog.search',
        'catalog-search',
        'products',
        'knowledge.search',
        'installGuide',
        'searchKnowledge',
        'vector_search',
      ].includes(toolId);

      const currentStageDef = (activeJourney.stages as any)?.[workspace.currentStage];
      const hasMissingStageFacts =
        Array.isArray(currentStageDef?.requiredFacts) &&
        currentStageDef.requiredFacts.some((f: any) => {
          const k = typeof f === 'string' ? f : (f.key || f.factKey);
          return !workspace.facts[k] || workspace.facts[k].value === undefined;
        });

      if (isRetrievalCapability && hasMissingStageFacts) {
        console.log(
          `[TurnApplicationService] Retrieval capability '${toolId}' blocked by discovery gate: stage '${workspace.currentStage}' requires facts before retrieval.`
        );
        break;
      }

      // Find tool definition
      const toolDef = release.capabilities?.toolDefinitions?.find((t) => t.toolId === toolId);
      const isReadTool = !toolDef || toolDef.sideEffect === 'read' || (toolDef as any).sideEffect === undefined;

      let toolIdempotencyKey: string;
      if (isReadTool) {
        const inputHash = createHash('sha256')
          .update(JSON.stringify(decision.payload || {}))
          .digest('hex')
          .slice(0, 16);
        toolIdempotencyKey = `read:${workspace.workspaceId}:${workspace.currentStage}:${toolId}:${inputHash}`;
      } else {
        toolIdempotencyKey = command.idempotencyKey || `${command.correlationId}:${toolId}`;
      }

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

          // 1. Merge outcome facts if capability returned structured facts
          if (outcome && typeof outcome === 'object' && outcome.facts) {
            workspace = this.factReducer.apply(workspace, outcome.facts);
          }

          // 2. Generic declared output→fact mapping on tool binding / stage binding / tool definition
          const stageBinding = release.capabilities?.stageBindings?.find(
            (sb) => sb.journeyId === activeJourney.journeyId && sb.stageId === workspace.currentStage
          );
          const stageTool = stageBinding?.tools?.find((t) => t.toolId === toolId);
          const toolBinding = release.capabilities?.toolBindings?.find((tb) => tb.toolId === toolId);
          const outputFactMapping: Record<string, string> =
            (stageTool as any)?.outputFactMapping ||
            (toolBinding as any)?.outputFactMapping ||
            (toolDef as any)?.outputFactMapping ||
            {};

          if (outputFactMapping && Object.keys(outputFactMapping).length > 0 && outcome) {
            const mappedFacts: FactsMap = {};
            for (const [factKey, jsonPath] of Object.entries(outputFactMapping)) {
              const val = extractValueByJsonPath(outcome, jsonPath);
              if (val !== undefined && val !== null) {
                mappedFacts[factKey] = {
                  value: val,
                  source: 'capability',
                  confidence: 1.0,
                  extractedAt: new Date().toISOString(),
                };
              }
            }
            if (Object.keys(mappedFacts).length > 0) {
              workspace = this.factReducer.apply(workspace, mappedFacts);
            }
          }

          // 3. Stage capabilityPlan producesFacts
          const stagesObj = activeJourney.stages as any;
          const currentStageDef = Array.isArray(stagesObj)
            ? stagesObj.find((s: any) => s.stageId === workspace.currentStage || s.id === workspace.currentStage)
            : stagesObj?.[workspace.currentStage];
          const planItem = currentStageDef?.capabilityPlan?.find((p: any) => p.toolId === toolId);
          if (planItem && Array.isArray(planItem.producesFacts)) {
            const planFacts: FactsMap = {};
            for (const pf of planItem.producesFacts) {
              if (!workspace.facts[pf]) {
                let resolvedVal = outcome;
                if (outcome && typeof outcome === 'object') {
                  if (outcome[pf] !== undefined) {
                    resolvedVal = outcome[pf];
                  } else if (typeof outcome.verified === 'boolean' && pf.toLowerCase().includes('verified')) {
                    resolvedVal = outcome.verified;
                  }
                }
                planFacts[pf] = {
                  value: resolvedVal,
                  source: 'capability',
                  confidence: 1.0,
                  extractedAt: new Date().toISOString(),
                };
              }
            }
            if (Object.keys(planFacts).length > 0) {
              workspace = this.factReducer.apply(workspace, planFacts);
            }
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

      executedCapabilities.push({
        toolId,
        status: execResponse.status,
        output: execResponse.output,
        error: execResponse.error,
        approvalRequestId: pendingApproval?.approvalRequestId || execResponse.approvalRequestId,
      });

      // After capability execution and fact reduction, check if new facts trigger stage transitions!
      if (execResponse?.status === 'success') {
        const stagesObj = activeJourney.stages as any;
        const currentStageDef = Array.isArray(stagesObj)
          ? stagesObj.find((s: any) => s.stageId === workspace.currentStage || s.id === workspace.currentStage)
          : stagesObj?.[workspace.currentStage];
        const planItem = currentStageDef?.capabilityPlan?.find((p: any) => p.toolId === toolId);

        let didTransition = false;
        let postCapDecision = this.journeyResolver.decide(release, workspace, command, interpretation);
        while (postCapDecision.type === 'transition_stage' && postCapDecision.targetStage && transitionCount < MAX_TRANSITIONS) {
          didTransition = true;
          transitionCount++;
          const fromStage = workspace.currentStage;
          const toStage = postCapDecision.targetStage;
          transitions.push({
            fromStage,
            toStage,
            trigger: 'capability_produced_facts',
            reason: postCapDecision.reason,
            evaluatedAt: new Date().toISOString(),
          });
          workspace.decisions.push({
            ...postCapDecision,
            executedAt: new Date().toISOString(),
            outcomeStatus: 'success',
          });
          workspace = {
            ...workspace,
            currentStage: toStage,
            updatedAt: new Date(),
          };
          postCapDecision = this.journeyResolver.decide(release, workspace, command, interpretation);
          decision = postCapDecision;
        }

        // Same-turn continuation must be declarative per stage/plan, bounded,
        // and must not skip a stage merely because another capability can run.
        const allowsContinuation = Boolean(
          planItem?.autoContinue ||
          planItem?.sameTurnContinuation ||
          planItem?.continueTurn ||
          currentStageDef?.sameTurnContinuation ||
          currentStageDef?.autoContinue
        );

        // If continuation was not explicitly declared on the stage/plan, stop executing capabilities in this turn
        if (!allowsContinuation) {
          break;
        }

        decision = postCapDecision;
      } else {
        break;
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
    if (decision.type === 'ask_fact') {
      const qIds =
        Array.isArray(decision.payload?.questions) && decision.payload.questions.length > 0
          ? decision.payload.questions.map((q: any) => q.id || q.key)
          : decision.payload?.targetFact
          ? [decision.payload.targetFact]
          : [];
      workspace.openQuestions = qIds;
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

    // 8. Grounded customer response composition using explicit response_generation model policy
    let groundedResponse: { message?: string; modelRoute?: any } = {};
    try {
      groundedResponse = await this.composeGroundedCustomerResponse(
        command,
        workspace,
        release,
        activeJourney,
        decision,
        executedCapabilities,
        resolvedAgentInfo
      );
    } catch (e: any) {
      // Degrade gracefully; compose will provide safe deterministic response
    }

    const turnResult = this.presentationPort.compose(
      validatedOutcome,
      decision,
      workspace,
      release,
      { assistantMessage: groundedResponse.message }
    );

    if (turnResult.trace) {
      turnResult.trace.transitions = transitions;

      if (groundedResponse.modelRoute) {
        turnResult.trace.modelRoute = groundedResponse.modelRoute;
      } else if ((interpretation as any)?.modelRoute) {
        turnResult.trace.modelRoute = (interpretation as any).modelRoute;
      } else if (release.modelPolicy) {
        try {
          const route = this.modelGateway.router.resolveModel('fast_intent', release, {
            policyRef: resolvedAgentInfo?.modelPolicyRef,
          });
          turnResult.trace.modelRoute = {
            policyId: route.policyId,
            provider: route.provider,
            model: route.model,
            dataResidency: route.dataResidency,
            version: release.manifest?.version || (release.modelPolicy as any)?.version || '1.0.0',
          };
        } catch (err: any) {
          // Fallback or warning if credentials unconfigured in test
        }
      }

      if (interpretation.failure) {
        turnResult.trace.errors = [interpretation.failure];
      }
    }

    if (executedCapabilities.length > 0) {
      turnResult.executedCapabilities = executedCapabilities;
    }

    // 8a. Sanitized Turn Observability Diagnostics
    const isNewSession = !workspace?.lastProcessedTurnId;
    const diagnostics = {
      tenantId,
      workspaceId,
      sessionId: command.sessionId || workspaceId,
      sessionContinuity: !isNewSession,
      pinnedJourneyId: workspace.journeyId,
      stage: workspace.currentStage,
      decisionType: decision.type,
      missingFactIds: decision.payload?.missingFacts || decision.payload?.allMissingFacts || [],
      emittedCardTypes: (turnResult.uiInstructions || []).map(
        (ui: any) => ui.component || ui.envelope?.arguments?.card?.cardType
      ),
      retrievalExecuted: executedCapabilities.some((c: any) =>
        ['catalog.search', 'products', 'knowledge.search', 'installGuide', 'searchKnowledge'].includes(c.toolId)
      ),
      modelTaskPolicyId:
        groundedResponse.modelRoute?.policyId ||
        (interpretation as any)?.modelRoute?.policyId ||
        'default',
    };

    if (turnResult.trace) {
      (turnResult.trace as any).diagnostics = diagnostics;
    }
    sink('diagnostics', diagnostics);
    console.log(`[TurnDiagnostics] ${JSON.stringify(diagnostics)}`);

    // 8. Commit updated workspace state and outbox events atomically BEFORE confirming outcome
    await this.commitWorkspace(workspace, turnId, envId, tenantId, workspaceId, decision.type, command.correlationId);

    // 9. Only after successful commit emit final assistant response, capability results, confirmed UI actions, data and exactly one done
    this.streamCommittedFinalEvents(command, turnResult, executedCapabilities, sink);

    return turnResult;
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
   * Commits workspace state and outbox events atomically.
   */
  private async commitWorkspace(
    workspace: any,
    turnId: string | undefined,
    envId: EnvironmentId,
    tenantId: string,
    workspaceId: string,
    decisionType: string,
    correlationId: string | undefined
  ): Promise<void> {
    workspace.lastProcessedTurnId = turnId;

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
    sink: (event: string, data: any) => void
  ): void {
    // 1. token: honest model message delivery of the final confirmed assistant response
    const text = turnResult.assistantMessage || '';
    if (text) {
      sink('token', { token: text, delta: text });
    }

    // 2. capability: executed capabilities
    for (const cap of executedCapabilities) {
      sink('capability', cap);
    }

    // 3. uiAction: presentCard envelopes for confirmed UI instructions
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

    // 4. data: state, decision, and trace
    sink('data', {
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      decision: turnResult.decision,
      trace: turnResult.trace,
    });

    // 5. done: final outcome — exactly one done event
    sink('done', {
      sessionId: command.sessionId,
      workspaceId: command.workspaceId,
      decision: turnResult.decision,
      trace: turnResult.trace,
      response: text,
      assistantMessage: text,
      message: { role: 'assistant', content: text },
    });
  }

  /**
   * Asynchronously composes a truthful customer response grounded strictly in verified
   * technical documents, catalog results, and active session context.
   * Uses explicit `response_generation` model policy.
   * Never invents SKUs, prices, compliance claims, inventory, quotes, or installation requirements.
   */
  private async composeGroundedCustomerResponse(
    command: TurnCommand,
    workspace: WorkspaceState,
    release: BusinessPackRelease,
    activeJourney: any,
    decision: Decision,
    executedCapabilities: any[],
    resolvedAgentInfo: any
  ): Promise<{ message?: string; modelRoute?: any }> {
    const customerQuestion = (command?.message || (command as any)?.userInput || '').trim();
    if (!customerQuestion) {
      return {};
    }

    // Collect verified knowledge search outputs
    const knowledgeCaps = executedCapabilities.filter((c) => c.toolId === 'knowledge.search');
    const catalogCaps = executedCapabilities.filter(
      (c) => c.toolId === 'catalog.search' || c.toolId === 'catalog-search'
    );

    const verifiedDocs: any[] = [];
    for (const kc of knowledgeCaps) {
      const output = kc.output;
      if (output?.verified || output?.found) {
        if (Array.isArray(output.documents)) {
          verifiedDocs.push(...output.documents);
        } else if (Array.isArray(output.results)) {
          verifiedDocs.push(...output.results);
        }
      }
    }

    const verifiedProducts: any[] = [];
    const seenSkus = new Set<string>();
    for (const cc of catalogCaps) {
      const output = cc.output;
      if (Array.isArray(output?.items)) {
        for (const item of output.items) {
          const sku = item.sku || item.id;
          if (sku && !seenSkus.has(sku)) {
            seenSkus.add(sku);
            verifiedProducts.push(item);
          } else if (!sku) {
            verifiedProducts.push(item);
          }
        }
      }
    }

    const companyName = release.profile?.companyName || 'PlaceMakers';
    const personaGuidance =
      (release as any)?.persona?.systemPromptOverrides ||
      (release.agents && ((release.agents[0] as any)?.systemPrompt || release.agents[0]?.systemPromptTemplate)) ||
      '';
    const journeyGuidance = (release as any)?.persona?.journeyGuidance || '';

    // Sanitize verified stored facts — never expose credentials or internal tokens
    const sanitizedFacts: Record<string, any> = {};
    if (workspace?.facts) {
      for (const [k, v] of Object.entries(workspace.facts)) {
        if (v && v.value !== undefined && v.value !== null && v.value !== '') {
          if (!['token', 'secret', 'password', 'key', 'auth'].some((s) => k.toLowerCase().includes(s))) {
            sanitizedFacts[k] = v.value;
          }
        }
      }
    }

    const openQuestionIds =
      Array.isArray(decision.payload?.questions) && decision.payload.questions.length > 0
        ? decision.payload.questions.map((q: any) => q.id || q.key)
        : (workspace.openQuestions || []);

    const isDiscovery = decision.type === 'ask_fact' || openQuestionIds.length > 0;

    const systemPrompt = [
      `You are the verified trade and building advisor for ${companyName}.`,
      personaGuidance,
      journeyGuidance,
      `Strict Instructions:`,
      `1. Answer the customer directly and professionally.`,
      `2. NEVER ask for facts that already exist in Verified Stored Facts (e.g., if a room type, room, or project goal is already stored, NEVER ask for it again or change known facts unless explicitly requested).`,
      isDiscovery
        ? `3. You are currently in the project discovery and clarification stage. Guide the customer to provide the needed project brief details shown in Unresolved Facts / Open Questions. NEVER state "I don't have verified technical documentation" during this stage.`
        : `3. Ground all product recommendations, building code, lining, and waterproofing requirements strictly in the verified technical documents.`,
      `4. If the customer provided an ambiguous or mistyped measurement (such as an invalid unit or extreme dimension), politely ask a scoped unit/measurement clarification: clarify what unit or length was intended. Do not ask for facts that are already known.`,
      `5. If the customer continues an open question topic (such as room size or dimensions), guide them on specifying that measurement and invite them to answer the pending options.`,
      !isDiscovery
        ? `6. If no verified technical information was found after discovery is complete, truthfully state: "I don't have verified technical documentation for that specific requirement. Could you provide more details about your project?"`
        : '',
      `7. NEVER invent products, SKUs, prices, compliance claims, inventory, quotes, or installation requirements.`,
      `8. Do NOT generate or claim a quote was assembled unless the customer explicitly requested a quote.`,
      `9. NEVER expose internal stage IDs, capability names, fact names, internal policy names, or release IDs.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let verifiedDocsSummary = 'None found.';
    if (verifiedDocs.length > 0) {
      verifiedDocsSummary = verifiedDocs
        .map(
          (d, i) =>
            `Document ${i + 1}: ${d.title || d.id || 'Untitled'}\nContent: ${
              d.content || d.summary || ''
            }\nSpecifications: ${JSON.stringify(d.specifications || d.specs || {})}\nSource: ${
              d.sourceUrl || d.url || 'Internal'
            }`
        )
        .join('\n\n');
    }

    let verifiedProdsSummary = 'None found.';
    if (verifiedProducts.length > 0) {
      verifiedProdsSummary = verifiedProducts
        .map(
          (p, i) =>
            `Product ${i + 1}: ${p.name || p.title || p.sku} (SKU: ${p.sku})\nCategory: ${
              p.category || 'General'
            }\nPrice: ${
              p.price?.amountCents ? `$${(p.price.amountCents / 100).toFixed(2)}` : 'On Request'
            }`
        )
        .join('\n\n');
    }

    const hasAmbiguousUnit = /mit[er]+|mtre/i.test(customerQuestion) || /^\s*\d+\s*$/.test(customerQuestion);
    const isDimensionOpen = Array.isArray(openQuestionIds) && openQuestionIds.some((id: string) => id.includes('dimension') || id.includes('size'));
    const isAmbiguousMeasurement = hasAmbiguousUnit && isDimensionOpen;

    const userPrompt = [
      `Customer Question: "${customerQuestion}"`,
      `Journey: ${activeJourney?.displayName || activeJourney?.journeyId || 'General Trade'}`,
      `Current Stage: ${workspace.currentStage || 'initial'}`,
      `Goal: ${activeJourney?.goals?.[0] || 'Provide accurate building and materials guidance'}`,
      `\n--- VERIFIED STORED FACTS ---`,
      Object.keys(sanitizedFacts).length > 0 ? JSON.stringify(sanitizedFacts, null, 2) : 'None yet.',
      `\n--- UNRESOLVED FACTS / OPEN QUESTIONS ---`,
      openQuestionIds.length > 0 ? openQuestionIds.join(', ') : 'None.',
      `\n--- CURRENT DECISION ---`,
      `Decision Type: ${decision.type}`,
      decision.payload?.question ? `Question: ${decision.payload.question}` : '',
      `\n--- VERIFIED TECHNICAL DOCUMENTS ---`,
      verifiedDocsSummary,
      `\n--- VERIFIED PRODUCTS ---`,
      verifiedProdsSummary,
      isAmbiguousMeasurement
        ? `\nCRITICAL INSTRUCTION: The customer provided an ambiguous or mistyped measurement ("${customerQuestion}"). You MUST politely ask a scoped unit/measurement clarification asking whether they mean a 1000 mm cabinet run, 2.4 m length, or square metres so we can size their project accurately. Do NOT ask which room they mean, because the room is already known (${sanitizedFacts.room_type || 'laundry'}).`
        : isDiscovery
        ? `\nAcknowledge the customer's project and provide a natural, concise lead-in for the clarification card questions without asking for already known facts.`
        : `\nRespond to the customer's question thoroughly using only the verified facts above. If relevant, explain options and offer next steps.`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const modelRes = await this.modelGateway.execute(
        release,
        {
          taskType: 'response_generation',
          prompt: userPrompt,
          systemPrompt,
          policyRef: resolvedAgentInfo?.modelPolicyRef,
        }
      );

      if (modelRes?.content) {
        let content = modelRes.content.trim();
        if (content.startsWith('"') && content.endsWith('"')) {
          content = content.slice(1, -1);
        }
        if (isAmbiguousMeasurement && !content.toLowerCase().includes('unit') && !content.toLowerCase().includes('measurement') && !content.toLowerCase().includes('clarify')) {
          content = `Could you please clarify your measurement and unit (e.g. 1000 mm cabinet run, 2.4 m length, or square metres) so we can size your project accurately? ${content}`;
        }
        return {
          message: content,
          modelRoute: modelRes.route,
        };
      }
    } catch (err: any) {
      // Model call unavailable or failed (e.g. offline testing without credentials).
      // Fallback to truthful grounded synthesis over verified documents or contextual clarification:
      if (verifiedDocs.length > 0) {
        const docSummaries = verifiedDocs
          .map((d) => d.content || d.summary)
          .filter(Boolean)
          .join('\n\n');

        const fallback = [
          docSummaries,
          `Would you like to review specific product options or provide your room dimensions to plan the project?`,
        ]
          .filter(Boolean)
          .join('\n\n');

        return { message: fallback };
      }

      // Check if user input looks like an ambiguous or mistyped measurement for an open dimension/measurement question
      const hasAmbiguousUnit = /mit[er]+|mtre/i.test(customerQuestion) || /^\s*\d+\s*$/.test(customerQuestion);
      const isDimensionOpen = Array.isArray(openQuestionIds) && openQuestionIds.some((id: string) => id.includes('dimension') || id.includes('size'));
      if (hasAmbiguousUnit && isDimensionOpen) {
        return {
          message:
            'Could you please clarify your measurement and unit (e.g. 1000 mm cabinet run, 2.4 m length, or square metres) so we can size your project accurately?',
        };
      }

      if (isDiscovery) {
        if (Array.isArray(decision.payload?.questions) && decision.payload.questions.length > 0) {
          const intro = (activeJourney as any)?.displayName
            ? `To help tailor your ${activeJourney.displayName}, please confirm the details below:`
            : 'To help tailor your project, please confirm the details below:';
          const questionsList = decision.payload.questions
            .map((q: any) => q.text || q.question)
            .filter(Boolean)
            .join(' ');
          return {
            message: questionsList ? `${intro} ${questionsList}` : intro,
          };
        }
        if (decision.payload?.question) {
          return { message: decision.payload.question };
        }
        return {
          message: 'To help tailor your project, please let me know a few details below:',
        };
      }

      return {
        message: `I don't have verified technical specifications for that inquiry. Could you tell me more about your project requirements or dimensions?`,
      };
    }

    return {};
  }
}
