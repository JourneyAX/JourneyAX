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
  WorkspaceReleasePins,
  UIInstruction,
} from '@journeyax/journey-core';
import {
  BusinessPackRelease,
  computePackChecksum,
  getVerifiedBusinessPackMetadata,
} from '@journeyax/business-pack';
import { ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase } from '@journeyax/database';
import { PackRepository } from './pack.repository';
import { WorkspaceRepository } from './workspace.repository';
import { JourneyResolver } from './journey.resolver';
import { AgentRouter } from './agent.router';
import { ModelGateway } from './model.gateway';
import { CapabilityGateway } from './capability.gateway';
import { validateOkfGeneratedClaims, withholdUnsupportedClaims } from './okf-claim-validator';
import { shapeReply } from './reply-shaper';
import { renderOkfMessage } from '@journeyax/knowledge';
import { ApprovalService } from './approval.service';
import { ExecutionRepository } from './execution.repository';
import { OutboxRepository } from './outbox.repository';
import { PresentationPort } from './presentation.port';
import { catalogOutcome, decideConversation, describeTurn, pendingReadingMode, readState, readsWithoutModel, resolveConversationPolicy, STATE_KEY, writeState } from '../conversation';
import type { ConversationPlan } from '../conversation';
import { TurnInterpreter, isAmbiguousMeasurementAnswer } from '../turn/interpret-event';
import { resolveFactRole, resolveInterpretationPolicy } from '../turn/fact-semantics';
import { formatCatalogPrice } from '../turn/price-format';
import { FactReducer } from '../turn/fact-reducer';
import { OutcomeValidator } from '../turn/validate-outcome';
import {
  OkfKnowledgeControlPlane,
  type KnowledgeControlPlanePort,
} from './knowledge-control-plane';
import type { OkfGateDecision } from '@journeyax/knowledge';
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
    public readonly outcomeValidator: OutcomeValidator = new OutcomeValidator(),
    public readonly knowledgeControlPlane: KnowledgeControlPlanePort = new OkfKnowledgeControlPlane()
  ) {
    if (this.approvalService && !this.approvalService.getOutboxRepo()) {
      this.approvalService.setOutboxRepo(this.outboxRepo);
    }
  }

  private createWorkspacePins(release: BusinessPackRelease): WorkspaceReleasePins {
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

      // 4. Extract and reduce conversational facts through model-gateway & schema validation
      const { interpretation, knowledgeGate } = await this.readTurn(command, release, workspace);

      // Terminal knowledge outcomes answer from tenant/platform wording and never reach journey routing, the model
      // composer or any capability:
      //  - a required release that cannot load (fail closed)
      //  - an uncovered hazard: nothing governs it, so it escalates to a qualified professional
      //  - an uncovered technical requirement: nothing verified supports a claim
      const terminalMessageKey = knowledgeGate?.trace.reasonCodes.includes('knowledge_required_unavailable')
        ? 'knowledge_unavailable'
        : knowledgeGate?.trace.reasonCodes.includes('uncovered_problem')
        ? 'safety_unavailable_customer'
        : knowledgeGate?.trace.reasonCodes.includes('uncovered_technical')
        ? 'uncovered_technical_unverified'
        : undefined;
      if (knowledgeGate && terminalMessageKey) {
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
        workspace = this.factReducer.apply(workspace, interpretation.candidateFacts);
        const decision: Decision = {
          decisionId: `dec_${Date.now()}`,
          type: 'fail',
          payload: { error: renderOkfMessage(knowledgeGate.messages, terminalMessageKey), customerMessage: true },
          reason: renderOkfMessage(knowledgeGate.messages, terminalMessageKey),
          createdAt: new Date().toISOString(),
        };
        workspace.decisions.push({ ...decision, executedAt: new Date().toISOString(), outcomeStatus: 'failure' });
        const turnResult = this.presentationPort.compose({ valid: false, notes: decision.reason }, decision, workspace, release, { messages: knowledgeGate.messages });
        (turnResult.trace as any).knowledgeGate = knowledgeGate;
        await this.commitWorkspace(workspace, turnId, envId, tenantId, workspaceId, decision.type, command.correlationId);
        this.logTurn(release, knowledgeGate, interpretation, turnResult, 'the knowledge decision answers on its own (safety, nothing verified, or knowledge unavailable)');
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
      }

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
        this.logTurn(release, knowledgeGate, interpretation, turnResult, 'the journey resolver is unavailable');
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
      }

      // Governed concepts establish the verified domain; so does an explicit catalogue-only shopping fallback, which
      // routes to the pack's default journey (its own catalogue step decides what is retrieved).
      const establishesDomain = Boolean(
        (knowledgeGate?.conceptId && !['no_match', 'operational_journey'].includes(knowledgeGate.mode)) ||
        knowledgeGate?.trace.reasonCodes.includes('uncovered_shopping_catalogue_only'),
      );
      const routingInterpretation = establishesDomain
        ? {
            ...interpretation,
            // Routing-only marker: establishes that the query is in the pack's
            // verified domain without persisting an internal OKF ID as a fact.
            candidateFacts: {
              ...interpretation.candidateFacts,
              __okf_domain_match: {
                value: true,
                source: 'system',
                confidence: 1,
                extractedAt: new Date().toISOString(),
              },
            },
          }
        : interpretation;

      const routingCommand = knowledgeGate?.journeyRef?.journeyId
        ? { ...command, journeyId: knowledgeGate.journeyRef.journeyId }
        : command;

      const resolution = this.journeyResolver.resolveJourneyResolution(
        release,
        workspace || ({} as any),
        routingCommand,
        routingInterpretation
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
            release.manifest.version || release.manifest.packId,
            this.createWorkspacePins(release)
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
        this.logTurn(release, knowledgeGate, interpretation, turnResult, 'the request matches more than one journey');
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
            release.manifest.version || release.manifest.packId,
            this.createWorkspacePins(release)
          );
        }
        const decision = this.journeyResolver.decide(release, workspace, command, interpretation);

        let groundedResponse: { message?: string; modelRoute?: any } = {};
        if (command?.message && command.message.trim() && decision.type === 'handoff') {
          try {
            groundedResponse = await this.composeGroundedCustomerResponse(
              command,
              workspace,
              release,
              null,
              decision,
              [],
              null,
              knowledgeGate
            );
          } catch (e: any) {}
        }

        const turnResult = this.presentationPort.compose(
          { valid: false, notes: decision.reason },
          decision,
          workspace,
          release,
          {
            assistantMessage: groundedResponse.message,
            customerQuery: command?.message,
          }
        );
        if (turnResult.trace) {
          turnResult.trace.transitions = [];
          if (groundedResponse.modelRoute) {
            turnResult.trace.modelRoute = groundedResponse.modelRoute;
          } else if ((interpretation as any)?.modelRoute) {
            turnResult.trace.modelRoute = (interpretation as any).modelRoute;
          }
          if (knowledgeGate) (turnResult.trace as any).knowledgeGate = knowledgeGate;
        }
        sink('trace', {
          currentStage: workspace?.currentStage || 'initial',
          transitions: [],
        });
        this.logTurn(release, knowledgeGate, interpretation, turnResult, 'no journey matched the request');
        this.streamCommittedFinalEvents(command, turnResult, [], sink);
        return turnResult;
      }

    const activeJourney = resolution.journey;
    if (!activeJourney) {
      throw new Error(`[TurnApplicationService] No matching journey found for tenant='${tenantId}' goal/intent`);
    }

    if (!workspace) {
      const configuredEntryStage = knowledgeGate?.journeyRef?.entryStageId;
      if (configuredEntryStage && !(activeJourney.stages as any)?.[configuredEntryStage]) {
        throw new Error(
          `[TurnApplicationService] OKF entry stage '${configuredEntryStage}' does not exist in journey '${activeJourney.journeyId}'`
        );
      }
      workspace = await this.workspaceRepo.getOrCreate(
        tenantId,
        envId,
        workspaceId,
        activeJourney.journeyId,
        configuredEntryStage || activeJourney.initialStage,
        undefined,
        release.manifest.version || release.manifest.packId,
        this.createWorkspacePins(release)
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
    if (workspace.pins && knowledgeGate) workspace.pins.knowledgeEvaluatedAt = new Date().toISOString();
    if (knowledgeGate?.conceptId && release.knowledgeModel?.type === 'okf_release') {
      workspace.knowledgeContext = {
        releaseId: release.knowledgeModel.releaseId,
        checksum: release.knowledgeModel.checksum,
        conceptId: knowledgeGate.conceptId,
        journeyId: knowledgeGate.journeyRef?.journeyId || activeJourney.journeyId,
        selectedAt: new Date().toISOString(),
      };
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

    // OKF owns specificity and safety gates; journey stages continue to own the
    // end-to-end business process. Translate only the deterministic gate result
    // into the existing domain-neutral Decision contract.
    if (knowledgeGate?.clarification && (
      knowledgeGate.mode === 'clarify_then_search' ||
      knowledgeGate.mode === 'project_journey' ||
      decision.type === 'ask_fact'
    )) {
      decision = this.knowledgeClarificationDecision(knowledgeGate);
    } else if (
      knowledgeGate?.mode === 'safety_then_diagnose' &&
      knowledgeGate.safety?.guidanceUnavailable
    ) {
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'fail',
        payload: { error: renderOkfMessage(knowledgeGate.messages, 'safety_unavailable_customer'), customerMessage: true },
        reason: renderOkfMessage(knowledgeGate.messages, 'safety_unavailable_customer'),
        createdAt: new Date().toISOString(),
      };
    } else if (
      knowledgeGate?.mode === 'safety_then_diagnose' &&
      knowledgeGate.safety?.guidance?.length
    ) {
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'complete_goal',
        payload: {
          safetyGuidance: {
            heading: renderOkfMessage(knowledgeGate.messages, 'safety_heading'),
            blockedNotice: renderOkfMessage(knowledgeGate.messages, 'safety_products_paused'),
            sourceLabelTemplate: knowledgeGate.messages.verified_source_label,
            unavailableMessage: renderOkfMessage(knowledgeGate.messages, 'safety_unavailable_customer'),
            renderFailedMessage: renderOkfMessage(knowledgeGate.messages, 'safety_render_failed'),
            steps: knowledgeGate.safety.guidance,
            blocksProducts: knowledgeGate.safety.blocksProducts,
          },
        },
        reason: renderOkfMessage(knowledgeGate.messages, 'safety_guidance_reason'),
        createdAt: new Date().toISOString(),
      };
    }

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
    let presentationCapability: { toolId: string; payload?: Record<string, unknown> } | undefined;
    const basketWarnings = new Set<string>();

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
      const isKnowledgeCapability = [
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

      const isExplicitlyPlanned =
        currentStageDef?.nextDecisionPolicy === 'capability-first' ||
        currentStageDef?.capabilityPlan?.some((p: any) => p.toolId === toolId);

      // Project concepts route into a merchant-authored journey. Once that
      // journey has collected its declared facts, its explicit catalogue step
      // is authoritative; the project-level OKF gate must not deadlock it.
      const projectJourneyAllowsCatalog =
        knowledgeGate?.mode === 'project_journey' &&
        ['catalog.search', 'catalog-search', 'products'].includes(toolId) &&
        isExplicitlyPlanned &&
        !hasMissingStageFacts;

      if (
        isRetrievalCapability &&
        knowledgeGate?.retrieval.permission === 'blocked' &&
        !projectJourneyAllowsCatalog
      ) {
        console.log(
          `[TurnApplicationService] Retrieval capability '${toolId}' blocked by OKF mode '${knowledgeGate.mode}'.`
        );
        // Nothing was executed, so there is no outcome to validate; the customer is told in the tenant's own wording.
        executedToolId = null;
        const blockedNotice = knowledgeGate.claims.notices.join(' ') || renderOkfMessage(knowledgeGate.messages, 'nothing_to_show');
        decision = {
          decisionId: `dec_${Date.now()}`,
          type: 'fail',
          payload: { error: blockedNotice, customerMessage: true, blockedBy: knowledgeGate.mode },
          reason: blockedNotice,
          createdAt: new Date().toISOString(),
        };
        break;
      }

      if (isRetrievalCapability && knowledgeGate) {
        const knowledgeRef = release.knowledgeModel?.type === 'okf_release'
          ? release.knowledgeModel
          : undefined;
        decision = {
          ...decision,
          payload: {
            ...decision.payload,
            query: decision.payload?.query || command.message || '',
            categoryIds: knowledgeGate.retrieval.categoryIds,
            categoryPaths: knowledgeGate.retrieval.categoryPaths,
            excludeCategoryIds: knowledgeGate.retrieval.excludeCategoryIds,
            // Governed knowledge chose this scope; the customer's wording narrows it but must not empty it.
            scopeAuthoritative: knowledgeGate.retrieval.categoryIds.length + knowledgeGate.retrieval.categoryPaths.length > 0 ||
              Boolean(knowledgeGate.retrieval.groups?.length),
            groups: knowledgeGate.retrieval.presentation === 'grouped_overview'
              ? knowledgeGate.retrieval.groups
              : undefined,
            currency: decision.payload?.currency || release.profile?.primaryCurrency,
            maxResults:
              knowledgeGate.retrieval.presentation === 'grouped_overview'
                ? Math.max(1, knowledgeGate.retrieval.scope.length) * (knowledgeGate.retrieval.maxItemsPerGroup || 2)
                : decision.payload?.maxResults,
            ...(isKnowledgeCapability && knowledgeRef && knowledgeGate.evidence
              ? {
                  knowledgeScope: {
                    releaseId: knowledgeRef.releaseId,
                    version: knowledgeRef.version,
                    checksum: knowledgeRef.checksum,
                    conceptIds: knowledgeGate.evidence.conceptIds,
                    sourceRefs: knowledgeGate.evidence.sourceRefs,
                    requestedClaimClass: knowledgeGate.evidence.requestedClaimClass,
                  },
                }
              : {}),
          },
        };
      }

      // Preserve the exact governed capability input for presentation even
      // when successful output advances the workspace to another stage in the
      // same turn and replaces `decision` with the next-stage decision.
      presentationCapability = {
        toolId,
        payload: { ...(decision.payload || {}) },
      };

      if (isRetrievalCapability && hasMissingStageFacts && !isExplicitlyPlanned) {
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
          ...(release.knowledgeModel?.type === 'okf_release' && toolId === 'order.commit'
            ? { requiresAuthoritativeCart: true }
            : {}),
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

        const isCartMutation = ['cart.update', 'cart-update'].includes(toolId);
        const isCheckoutCommit = toolId === 'order.commit';
        const commerceBinding = (isCartMutation || isCheckoutCommit) && release.knowledgeModel?.type === 'okf_release'
          ? release.capabilities?.toolBindings?.find((binding) => binding.toolId === toolId &&
              (!binding.tenantId || binding.tenantId === tenantId) &&
              (!binding.environmentId || binding.environmentId === envId))
          : undefined;
        const basketPolicy = isCartMutation || isCheckoutCommit
          ? await this.knowledgeControlPlane.evaluateBasket(
              release, command, workspace,
              Array.isArray(decision.payload?.items) ? decision.payload.items : [],
              { operation: isCheckoutCommit ? 'order.commit' : 'cart.update', cartId: decision.payload?.cartId },
            )
          : null;
        const commercePolicy = basketPolicy?.commerce ||
          (release.knowledgeModel?.type === 'okf_release'
            ? { addToCart: 'blocked' as const, checkout: 'blocked' as const }
            : knowledgeGate?.commerce);
        const policyMessages = basketPolicy?.messages || knowledgeGate?.messages || {};
        const commercePolicyResult = (() => {
          const nativeHandler = commerceBinding?.executor.nativeHandler;
          const trustedCommerceHandler = commerceBinding?.executor.type === 'native_capability' &&
            (isCheckoutCommit ? nativeHandler === 'order.commit'
              : ['cart.update', 'cart-update'].includes(nativeHandler || ''));
          if (release.knowledgeModel?.type === 'okf_release' && (isCartMutation || isCheckoutCommit) &&
            !trustedCommerceHandler) {
            return {
              toolId, status: 'failure' as const,
              error: renderOkfMessage(policyMessages, 'cart_verification_unavailable'), durationMs: 0,
              provenance: { executorType: 'okf-policy-gate', executedAt: new Date().toISOString(), correlationId: command.correlationId },
            };
          }
          if (!commercePolicy) return undefined;
          if (isCartMutation && commercePolicy.addToCart === 'blocked') {
            return {
              toolId,
              status: 'failure' as const,
              error: renderOkfMessage(policyMessages, 'cart_blocked'),
              durationMs: 0,
              provenance: { executorType: 'okf-policy-gate', executedAt: new Date().toISOString(), correlationId: command.correlationId },
            };
          }
          if (isCheckoutCommit && commercePolicy.checkout === 'blocked') {
            return {
              toolId,
              status: 'failure' as const,
              error: renderOkfMessage(policyMessages, 'checkout_blocked'),
              durationMs: 0,
              provenance: { executorType: 'okf-policy-gate', executedAt: new Date().toISOString(), correlationId: command.correlationId },
            };
          }
          if (isCheckoutCommit && commercePolicy.checkout !== 'allowed') {
            return {
              toolId,
              status: 'requires_approval' as const,
              error: commercePolicy.checkout === 'requires_professional_confirmation'
                ? renderOkfMessage(policyMessages, 'checkout_requires_professional')
                : renderOkfMessage(policyMessages, 'checkout_requires_compatibility'),
              durationMs: 0,
              provenance: { executorType: 'okf-policy-gate', executedAt: new Date().toISOString(), correlationId: command.correlationId },
            };
          }
          return undefined;
        })();

        execResponse = commercePolicyResult || await this.capabilityGateway.executeCapability(
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
          if (basketPolicy) for (const warning of basketPolicy.warnings) basketWarnings.add(warning);
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
      // Only the rule author's own wording may reach the customer; engine diagnostics stay in the decision and the logs.
      const ruleMessage = (validatedOutcome as { customerMessage?: string }).customerMessage;
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'fail',
        payload: { error: ruleMessage ?? validatedOutcome.notes, violations: validatedOutcome.appliedRules, ...(ruleMessage ? { customerMessage: true } : {}) },
        reason: ruleMessage ?? validatedOutcome.notes ?? 'Outcome failed business validation rules',
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
      outcomeStatus: validatedOutcome.valid && decision.type !== 'fail' ? 'success' : 'failure',
    });

    // 7a. What a good salesperson does next: ask, recommend (with the reason), show, or answer in words. One decision for every
    // department, made from the knowledge decision, the products found and what the customer has already said.
    const conversationPlan = this.planConversation({ knowledgeGate, executedCapabilities, release, workspace, command, workspaceId, decision });

    // 7b. "Have you considered?" — unverified cross-sell from the matched concept. It is shown only next to real catalogue
    // results, as live products found by the same governed catalogue capability, and it adds no claim and no requirement.
    const suggestionInstruction = !conversationPlan || conversationPlan.showCards.suggestions
      ? await this.resolveSuggestionInstruction({ knowledgeGate, executedCapabilities, release, tenantId, envId, workspace, workspaceId, command })
      : null;

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
    // Verified safety instructions are rendered deterministically from the
    // pinned OKF release. Never send them through a model phrasing step.
    // "Nothing to show" is always the tenant's sentence, whoever words the rest of the reply.
    const templated = conversationPlan && conversationPlan.action !== 'defer' && conversationPlan.message &&
      (conversationPlan.action === 'empty' || resolveConversationPolicy(release).wording === 'template');
    if (templated) {
      // The sentence is the tenant's own wording filled with what the customer said and the product chosen; no model call is needed.
      groundedResponse = { message: conversationPlan!.message };
    } else if (!decision.payload?.safetyGuidance && !(decision.type === 'fail' && decision.payload?.customerMessage === true)) {
      // (A refusal written for the customer by the tenant's policy is shown exactly as written, so there is nothing for a model to word.)
      try {
        groundedResponse = await this.composeGroundedCustomerResponse(
          command,
          workspace,
          release,
          activeJourney,
          decision,
          executedCapabilities,
          resolvedAgentInfo,
          knowledgeGate
        );
      } catch (e: any) {
        // Degrade gracefully; compose will provide safe deterministic response
      }
    }

    const turnResult = this.presentationPort.compose(
      validatedOutcome,
      decision,
      workspace,
      release,
      {
        assistantMessage: groundedResponse.message,
        capability: presentationCapability,
        messages: knowledgeGate?.messages,
        recommendation: knowledgeGate?.recommendation,
        plan: conversationPlan ?? undefined,
      }
    );
    if (basketWarnings.size > 0) {
      turnResult.assistantMessage = [turnResult.assistantMessage, ...basketWarnings].filter(Boolean).join('\n\n');
    }
    // Required notices are a guarantee, not a request to the model: any the composed message omitted are appended.
    // Only notices written for the customer are appended; the agent-facing disclaimers stay in the prompt and the trace.
    // A question, or a plain "nothing to show", claims nothing about any product, so it carries no notice about products; every turn that shows or describes one does.
    if (knowledgeGate?.claims.notices.length && typeof turnResult.assistantMessage === 'string' && conversationPlan?.action !== 'ask' && conversationPlan?.action !== 'empty') {
      const missing = [...new Set(knowledgeGate.claims.notices)].filter((text) => text && !turnResult.assistantMessage.includes(text));
      if (missing.length > 0) turnResult.assistantMessage = [turnResult.assistantMessage, ...missing].filter(Boolean).join('\n\n');
    }
    // Order on screen: the question, then the examples, then the unverified "Have you considered?" extras.
    if (suggestionInstruction) turnResult.uiInstructions = [...(turnResult.uiInstructions || []), suggestionInstruction];

    if (conversationPlan && conversationPlan.action !== 'defer') {
      // The plan alone decides whether a question is on screen: a question the customer has already answered in words is not asked again.
      const rest = (turnResult.uiInstructions || []).filter((instruction) => instruction.component !== 'clarify');
      const question = conversationPlan.showCards.question && conversationPlan.question
        ? this.presentationPort.createKnowledgeClarificationInstruction(conversationPlan.question, release)
        : null;
      turnResult.uiInstructions = question ? [question, ...rest] : rest;
      if (question && conversationPlan.question!.source === 'okf' && !workspace.openQuestions.includes(conversationPlan.question!.factKey)) {
        workspace.openQuestions.push(conversationPlan.question!.factKey);
      }
      if (turnResult.trace) {
        (turnResult.trace as any).conversation = {
          action: conversationPlan.action,
          because: conversationPlan.because,
          needs: conversationPlan.needs,
          question: conversationPlan.question ? { source: conversationPlan.question.source, factKey: conversationPlan.question.factKey } : undefined,
          products: conversationPlan.products.map((entry) => ({ sku: entry.item.sku, score: Number(entry.score.toFixed(2)), matched: entry.matched, quoted: Boolean(entry.why?.excerpt) })),
        };
      }
    } else if (
      knowledgeGate?.clarification &&
      knowledgeGate.mode === 'overview_then_ask' &&
      !(turnResult.uiInstructions || []).some((instruction) => instruction.component === 'clarify')
    ) {
      const instruction = this.presentationPort.createKnowledgeClarificationInstruction(
        knowledgeGate.clarification,
        release
      );
      if (instruction) turnResult.uiInstructions = [instruction, ...(turnResult.uiInstructions || [])];
      if (!workspace.openQuestions.includes(knowledgeGate.clarification.factKey)) {
        workspace.openQuestions.push(knowledgeGate.clarification.factKey);
      }
    }

    if (turnResult.trace) {
      turnResult.trace.transitions = transitions;

      if (groundedResponse.modelRoute) {
        turnResult.trace.modelRoute = groundedResponse.modelRoute;
      } else if ((interpretation as any)?.modelRoute) {
        turnResult.trace.modelRoute = (interpretation as any).modelRoute;
      } else if (release.modelPolicy && !interpretation.modelSkipped) {
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
      if (interpretation.modelSkipped) (turnResult.trace as any).modelSkipped = interpretation.modelSkipped;
      if (knowledgeGate) {
        (turnResult.trace as any).knowledgeGate = knowledgeGate;
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
      packVersion: release.manifest?.version,
      okfRelease: release.knowledgeModel?.type === 'okf_release' ? `${release.knowledgeModel.releaseId}@${release.knowledgeModel.checksum.slice(0, 12)}` : 'none',
      knowledgeMode: knowledgeGate?.mode,
      knowledgeConceptId: knowledgeGate?.conceptId,
      knowledgeMatchedBy: knowledgeGate?.trace?.matchedBy,
      modelTaskPolicyId:
        groundedResponse.modelRoute?.policyId ||
        (interpretation as any)?.modelRoute?.policyId ||
        'default',
      modelRead: interpretation.modelSkipped ? `skipped (${interpretation.modelSkipped})` : interpretation.failure ? `failed (${interpretation.failure.type})` : 'used',
      catalogSearch: (({ ran, failed, items, error }) => ({ ran, failed, items: items.length, ...(error ? { error } : {}) }))(catalogOutcome(executedCapabilities)),
      conversationAction: conversationPlan?.action,
      conversationQuestion: conversationPlan?.question ? `${conversationPlan.question.source}:${conversationPlan.question.factKey}` : undefined,
      conversationNeeds: conversationPlan?.needs,
      conversationBecause: conversationPlan?.because,
      conversationProducts: conversationPlan?.products.map((entry) => ({ sku: entry.item.sku, score: Number(entry.score.toFixed(2)), matched: entry.matched, quoted: Boolean(entry.why?.excerpt) })),
    };

    if (turnResult.trace) {
      (turnResult.trace as any).diagnostics = diagnostics;
    }
    console.log(`[TurnDiagnostics] ${JSON.stringify(diagnostics)}`);
    console.log(describeTurn({
      packVersion: diagnostics.packVersion,
      okfRelease: diagnostics.okfRelease,
      knowledgeMode: diagnostics.knowledgeMode,
      conceptId: diagnostics.knowledgeConceptId,
      matchedBy: diagnostics.knowledgeMatchedBy,
      plan: conversationPlan,
      cards: diagnostics.emittedCardTypes,
      search: catalogOutcome(executedCapabilities),
      modelRead: diagnostics.modelRead,
    }));

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

  /** The one-line summary of a turn that ended before the normal diagnostics, so no turn goes unlogged. */
  private logTurn(release: BusinessPackRelease, gate: OkfGateDecision | null | undefined, interpretation: { modelSkipped?: string; failure?: { type: string } }, turnResult: TurnResult, endedBecause: string): void {
    console.log(describeTurn({
      packVersion: release.manifest?.version,
      okfRelease: release.knowledgeModel?.type === 'okf_release' ? `${release.knowledgeModel.releaseId}@${release.knowledgeModel.checksum.slice(0, 12)}` : 'none',
      knowledgeMode: gate?.mode,
      conceptId: gate?.conceptId,
      matchedBy: gate?.trace?.matchedBy,
      endedBecause,
      cards: (turnResult.uiInstructions || []).map((ui: any) => ui.component || ui.envelope?.arguments?.card?.cardType),
      modelRead: interpretation.modelSkipped ? `skipped (${interpretation.modelSkipped})` : interpretation.failure ? `failed (${interpretation.failure.type})` : 'used',
    }));
  }

  /**
   * Reads the customer's message and asks the knowledge decision what it means. The model that reads free text is the slowest step
   * of a turn (6 to 10 seconds), and for two kinds of message it has nothing to add: a tapped answer the release or the products'
   * own question can read exactly, and a plain "show me" for a shelf. For those the deterministic reading is tried first and kept when
   * it is complete; otherwise the model reads the message as it always did.
   */
  private async readTurn(command: TurnCommand, release: BusinessPackRelease, workspace: WorkspaceState | null) {
    const policy = resolveConversationPolicy(release);
    const message = (command.message || (command as any).userInput || '').trim();
    const mode = pendingReadingMode(message, policy);
    if (mode) {
      const quick = await this.interpreter.interpret(command, release, workspace || ({} as any), { model: false });
      const gate = await this.knowledgeControlPlane.evaluate(release, command, workspace, quick);
      if (gate && readsWithoutModel(mode, message, gate, quick.candidateFacts as any, policy)) {
        quick.modelSkipped = mode === 'tapped' ? 'tapped_answer' : 'browse_request';
        return { interpretation: quick, knowledgeGate: gate };
      }
    }
    const interpretation = await this.interpreter.interpret(command, release, workspace || ({} as any));
    const knowledgeGate = await this.knowledgeControlPlane.evaluate(release, command, workspace, interpretation);
    return { interpretation, knowledgeGate };
  }

  /**
   * The conversation decision for this turn, and what it remembers for the next. Another part of the platform keeps the reply when
   * the journey itself is asking a question, or the knowledge decision belongs to safety, evidence, orders or projects.
   */
  private planConversation(input: {
    knowledgeGate: OkfGateDecision | null | undefined;
    executedCapabilities: Array<{ toolId: string; status?: string; output?: any }>;
    release: BusinessPackRelease;
    workspace: WorkspaceState;
    command: TurnCommand;
    workspaceId: string;
    decision: Decision;
  }): ConversationPlan | null {
    const { knowledgeGate: gate, executedCapabilities, release, workspace, command, decision } = input;
    if (!gate) return null;
    if (decision.type === 'ask_fact' && !decision.payload?.knowledgeMode) return null;
    const search = catalogOutcome(executedCapabilities);
    const plan = decideConversation({
      message: (command.message || (command as any).userInput || '').trim(),
      gate,
      items: search.items,
      search,
      messages: { ...resolveInterpretationPolicy(release).messages, ...(gate.messages ?? {}) },
      state: readState(workspace.facts),
      policy: resolveConversationPolicy(release),
      seed: `${input.workspaceId}:${workspace.decisions.length}`,
    });
    if (plan.action === 'defer') return plan;
    writeState(workspace as { facts: Record<string, any> }, plan.nextState);
    return plan;
  }

  /**
   * Resolves the gate's unverified cross-sell into live catalogue products through the same governed catalogue capability
   * that produced the primary results. Nothing is shown unless real products came back; failures degrade to "no card".
   */
  private async resolveSuggestionInstruction(input: {
    knowledgeGate: OkfGateDecision | null | undefined;
    executedCapabilities: Array<{ toolId: string; status?: string; output?: any }>;
    release: BusinessPackRelease;
    tenantId: string;
    envId: EnvironmentId;
    workspace: WorkspaceState;
    workspaceId: string;
    command: TurnCommand;
  }): Promise<UIInstruction | null> {
    const { knowledgeGate: gate, executedCapabilities, release } = input;
    if (!gate?.suggestions?.length || gate.retrieval.permission !== 'allowed') return null;
    const primary = executedCapabilities.find((entry) =>
      ['catalog.search', 'catalog-search', 'products'].includes(entry.toolId) && entry.status === 'success' &&
      Array.isArray(entry.output?.items) && entry.output.items.length > 0);
    if (!primary) return null;
    const ctx: ExecutionContext = {
      tenantId: input.tenantId,
      environmentId: input.envId,
      workspaceId: input.workspaceId,
      sessionId: input.command.sessionId || input.workspaceId,
      principalId: input.command.principalId || 'customer',
      principalRole: input.command.principalRole || 'customer',
      stageId: input.workspace.currentStage,
      packVersionId: release.manifest.version || release.manifest.packId,
      correlationId: input.command.correlationId,
    };
    try {
      const response = await this.capabilityGateway.executeCapability(release, primary.toolId, {
        query: '',
        groups: gate.suggestions.map((suggestion) => ({
          conceptId: suggestion.conceptId, label: suggestion.name, categoryIds: suggestion.categoryIds, categoryPaths: suggestion.categoryPaths,
          excludeCategoryIds: suggestion.excludeCategoryIds, maxItems: suggestion.maxItems,
        })),
        currency: release.profile?.primaryCurrency,
        maxResults: gate.suggestions.length * Math.max(...gate.suggestions.map((suggestion) => suggestion.maxItems)),
      }, ctx);
      if (response.status !== 'success') return null;
      return this.presentationPort.createSuggestionsInstruction(
        gate.suggestions, Array.isArray(response.output?.groups) ? response.output.groups : [], release,
        { excludeSkus: primary.output.items.map((item: any) => String(item?.sku || item?.id || '')) },
      );
    } catch {
      return null;
    }
  }

  private knowledgeClarificationDecision(gate: OkfGateDecision): Decision {
    const clarification = gate.clarification;
    if (!clarification) {
      throw new Error('[TurnApplicationService] OKF clarification decision requested without clarification payload');
    }
    const inputTypeMap: Record<string, string> = {
      select: 'single_select',
      card_choice: 'single_select',
      multi_select: 'multi_select',
      number: 'number',
      slider: 'number',
      text: 'text',
      boolean_toggle: 'single_select',
    };
    return {
      decisionId: `dec_${Date.now()}`,
      type: 'ask_fact',
      payload: {
        targetFact: clarification.factKey,
        question: clarification.question,
        options: clarification.options.map((option) => option.label || option.value),
        inputType: inputTypeMap[clarification.uiInputType] || 'text',
        questions: [{
          id: clarification.factKey,
          text: clarification.question,
          options: clarification.options,
          inputType: inputTypeMap[clarification.uiInputType] || 'text',
          multi: clarification.uiInputType === 'multi_select',
        }],
        missingFacts: [clarification.factKey],
        knowledgeMode: gate.mode,
      },
      reason: `Structured knowledge requires '${clarification.factKey}' before a verified recommendation.`,
      createdAt: new Date().toISOString(),
    };
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
      sink('token', { token: text, delta: text });
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
    resolvedAgentInfo: any,
    knowledgeGate?: OkfGateDecision | null
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
    // Also include products from workspace.facts['catalog_results'] if current turn did not run catalog.search
    if (verifiedProducts.length === 0 && workspace?.facts?.['catalog_results']?.value) {
      const catVal = workspace.facts['catalog_results'].value;
      const catItems = Array.isArray(catVal) ? catVal : (catVal.items || catVal.products || []);
      for (const item of catItems) {
        const sku = item.sku || item.id;
        if (sku && !seenSkus.has(sku)) {
          seenSkus.add(sku);
          verifiedProducts.push(item);
        } else if (!sku) {
          verifiedProducts.push(item);
        }
      }
    }

    // A successful but empty live catalogue result cannot support "here are" or an
    // availability claim from the model. Use the merchant's configured empty-result
    // wording instead of asking the model to improvise products it did not see.
    if (release.knowledgeModel?.type === 'okf_release' &&
        knowledgeGate?.retrieval.permission === 'allowed' &&
        catalogCaps.some((cap) => Array.isArray(cap.output?.items) && !cap.output?.error) &&
        verifiedProducts.length === 0) {
      return { message: renderOkfMessage(resolveInterpretationPolicy(release).messages, 'nothing_to_show') };
    }

    const companyName = release.profile?.companyName || release.manifest?.name || 'Customer Consultant';
    const replyPolicy = resolveInterpretationPolicy(release);
    // The prompt comes from the agent the router actually resolved for this workspace, never from list position.
    const resolvedAgent: any = resolvedAgentInfo?.agentId
      ? (release.agents || []).find((candidate: any) => candidate.agentId === resolvedAgentInfo.agentId)
      : undefined;
    const personaGuidance =
      (release as any)?.persona?.systemPromptOverrides ||
      resolvedAgent?.systemPrompt || resolvedAgent?.systemPromptTemplate ||
      '';
    const journeyGuidance = (release as any)?.persona?.journeyGuidance || '';

    // Sanitize verified stored facts — never expose credentials or internal tokens
    const sanitizedFacts: Record<string, any> = {};
    if (workspace?.facts) {
      for (const [k, v] of Object.entries(workspace.facts)) {
        if (v && v.value !== undefined && v.value !== null && v.value !== '' && k !== STATE_KEY) {
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

    const isAskingForDetails = /tell me more|more info|more detail|tell me about|explain|details|specs|specifications|features|how does|how do i use|what is|how to/i.test(customerQuestion);
    const isOutOfDomain = decision.type === 'handoff' || !activeJourney;
    const isDiscovery = !isOutOfDomain && !isAskingForDetails && (decision.type === 'ask_fact' || openQuestionIds.length > 0);

    const isExplicitTechnicalDocQuery =
      knowledgeGate?.mode === 'evidence_answer' ||
      /\b(compliance|certificate|specification|technical document|technical data|warranty|installation guide|care guide)\b/i.test(customerQuestion);

    const systemPrompt = isOutOfDomain
      ? [
          `You are the verified customer advisor for ${companyName}.`,
          release.profile?.industry ? `Industry: ${release.profile.industry}.` : '',
          personaGuidance,
          `Strict Instructions:`,
          `1. The customer's inquiry falls outside the published products, services, and journeys for ${companyName}${release.profile?.industry ? ` (${release.profile.industry})` : ''}.`,
          `2. Politely explain the scope boundary without inventing an offering. Mention only configured journeys supplied below.`,
          `3. Keep the tone consistent with the published persona and brand guidance.`,
          `4. Offer to assist with one of the configured journeys.`,
          `5. Keep the response concise (2-3 sentences).`,
          `6. NEVER expose internal policy names, stage IDs, or error codes.`,
        ]
          .filter(Boolean)
          .join('\n\n')
      : [
          `You are the verified customer advisor for ${companyName}.`,
          personaGuidance,
          journeyGuidance,
          `Strict Instructions:`,
          `1. Answer the customer directly and professionally.`,
          `2. NEVER ask for facts that already exist in Verified Stored Facts (NEVER ask for an answer that is already stored, and never change known facts unless the customer explicitly corrects them).`,
          isDiscovery
            ? `3. You are currently in the project discovery and clarification stage. Guide the customer to provide the needed project brief details shown in Unresolved Facts / Open Questions. NEVER state "I don't have verified technical documentation" during this stage.`
            : isAskingForDetails
            ? `3. Provide comprehensive, helpful, and professional product details, usage directions, and specifications based strictly on the verified catalog items.`
            : `3. Ground every recommendation and regulated, compatibility, installation, care, safety, or warranty claim strictly in verified evidence supplied to this turn.`,
          `4. If the customer provided an ambiguous or mistyped measurement (such as an invalid unit or extreme dimension), politely ask a scoped unit/measurement clarification: clarify what unit or length was intended. Do not ask for facts that are already known.`,
          `5. If the customer continues an open question topic (such as a pending measurement), guide them on specifying it and invite them to answer the pending options.`,
          isExplicitTechnicalDocQuery && verifiedDocs.length === 0
            ? `6. If no verified technical information was found after search, truthfully state: "I don't have verified technical documentation for that specific requirement. Could you provide more details about your project?"`
            : `6. If answering trade, troubleshooting, or product inquiries, provide helpful practical guidance and ask clarifying questions to diagnose the issue (e.g. cause, location, materials involved). Do NOT mention missing technical documentation unless the customer explicitly asked for technical certificates or specification sheets.`,
          `7. NEVER invent products, SKUs, prices, compliance claims, inventory, quotes, or installation requirements.`,
          `8. Do NOT generate or claim a quote was assembled unless the customer explicitly requested a quote.`,
          `9. NEVER expose internal stage IDs, capability names, fact names, internal policy names, or release IDs.`,
          knowledgeGate
            ? `10. Enforce the structured knowledge decision: recommendation=${knowledgeGate.recommendation}; allowed claims=${knowledgeGate.claims.allowedClasses.join(', ') || 'none'}; disclaimers=${knowledgeGate.claims.disclaimers.join(' | ') || 'none'}. Do not make any claim class not listed.`
            : '',
          release.knowledgeModel?.type === 'okf_release' && replyPolicy.replyStyle.rules.length
            ? `Style (follow strictly):\n${replyPolicy.replyStyle.rules.map((rule) => `- ${rule}`).join('\n')}`
            : '',
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
              formatCatalogPrice(p.priceCents != null ? p.priceCents / 100 : p.price, p.currency || p.price?.currency || release.profile?.primaryCurrency, renderOkfMessage(resolveInterpretationPolicy(release).messages, 'price_on_request'))
            }\nDescription: ${p.description || p.reason || 'Verified catalog item'}${p.features ? `\nFeatures: ${Array.isArray(p.features) ? p.features.join(', ') : p.features}` : ''}${p.specifications ? `\nSpecifications: ${JSON.stringify(p.specifications)}` : ''}`
        )
        .join('\n\n');
    }

    const interpretationMessages = resolveInterpretationPolicy(release).messages;
    // A bare number (optionally followed by one unrecognised word) answering an open measurement question is ambiguous.
    const isBareMeasurementAnswer = isAmbiguousMeasurementAnswer(customerQuestion);
    const isDimensionOpen = Array.isArray(openQuestionIds) && openQuestionIds.some((id: string) => resolveFactRole(release, id) === 'measurement');
    const isAmbiguousMeasurement = isBareMeasurementAnswer && isDimensionOpen;

    const userPrompt = isOutOfDomain
      ? [
          `Customer Question: "${customerQuestion}"`,
          `Status: Out of scope / no matching journey in our catalog.`,
          `Our Company: ${companyName}`,
          release.profile?.industry ? `Industry: ${release.profile.industry}` : '',
          `Available Services / Projects: ${release.journeys.map((j) => j.displayName || j.journeyId).join(', ')}`,
          `Instruction: Politely explain that the request is outside the published offering. Mention only the configured journeys above, and ask whether one of those would help.`,
        ].join('\n')
      : [
          `Customer Question: "${customerQuestion}"`,
          `Journey: ${activeJourney?.displayName || activeJourney?.journeyId || renderOkfMessage(knowledgeGate?.messages || {}, 'default_journey_label')}`,
          `Current Stage: ${workspace.currentStage || 'initial'}`,
          `Goal: ${activeJourney?.goals?.[0] || renderOkfMessage(knowledgeGate?.messages || {}, 'default_goal')}`,
          `\n--- VERIFIED STORED FACTS ---`,
          Object.keys(sanitizedFacts).length > 0 ? JSON.stringify(sanitizedFacts, null, 2) : 'None yet.',
          `\n--- UNRESOLVED FACTS / OPEN QUESTIONS ---`,
          openQuestionIds.length > 0 ? openQuestionIds.join(', ') : 'None.',
          `\n--- CURRENT DECISION ---`,
          `Decision Type: ${decision.type}`,
          decision.payload?.question ? `Question: ${decision.payload.question}` : '',
          knowledgeGate ? `Knowledge response mode: ${knowledgeGate.mode}` : '',
          knowledgeGate?.clarification ? `A question card on screen already asks the customer: "${knowledgeGate.clarification.question}". Lead into it in a few words; do not repeat, paraphrase or add to it.` : '',
          knowledgeGate ? `Allowed claim classes: ${knowledgeGate.claims.allowedClasses.join(', ') || 'none'}` : '',
          knowledgeGate?.claims.disclaimers.length ? `Required disclaimers: ${knowledgeGate.claims.disclaimers.join(' | ')}` : '',
          `\n--- VERIFIED TECHNICAL DOCUMENTS ---`,
          verifiedDocsSummary,
          `\n--- VERIFIED PRODUCTS ---`,
          verifiedProdsSummary,
          isAmbiguousMeasurement
            ? `\nCRITICAL INSTRUCTION: The customer provided an ambiguous or mistyped measurement ("${customerQuestion}"). Ask only for the missing unit or scale required by the published fact definition. Do not ask again for any context already present in verified stored facts.`
            : isAskingForDetails
            ? `\nCRITICAL INSTRUCTION: The customer is asking for more details or an explanation about products ("${customerQuestion}"). Provide a detailed, professional, and helpful explanation of the product features, active ingredients, usage instructions, and benefits based STRICTLY on the VERIFIED PRODUCTS data below. Do not ask intake questions.`
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
          content = `${renderOkfMessage(interpretationMessages, 'measurement_clarification')} ${content}`;
        }
        // What the model wrote is shaped before anyone reads it: no internal ids, no second question, no "go and browse", short.
        const shape = (text: string): string => {
          if (release.knowledgeModel?.type !== 'okf_release') return text;
          const idsOf = (conceptId?: string) => (conceptId ? conceptId.replace(/^concept:\/\//, '').split('/').slice(1) : []);
          const shaped = shapeReply(text, {
            style: replyPolicy.replyStyle,
            companyNames: [release.profile?.companyName, release.manifest?.name].filter((name): name is string => Boolean(name)),
            internalIds: [
              ...idsOf(knowledgeGate?.conceptId),
              ...(knowledgeGate?.retrieval?.scope ?? []).flatMap(idsOf),
              ...(knowledgeGate?.retrieval?.groups ?? []).flatMap((group) => [...idsOf(group.conceptId), ...group.categoryIds]),
              ...(knowledgeGate?.retrieval?.categoryIds ?? []),
              ...(knowledgeGate?.clarification ? [knowledgeGate.clarification.factKey] : []),
            ],
            questionCardShown: Boolean(knowledgeGate?.clarification) || decision.type === 'ask_fact',
          });
          if (shaped.removed.length) {
            console.warn(`[ReplyShaper] removed ${shaped.removed.length} sentence(s) from the model reply: ${shaped.removed.slice(0, 4).map((entry) => `${entry.reason} ("${entry.sentence.slice(0, 80)}")`).join('; ')}`);
          }
          return shaped.text || (knowledgeGate?.clarification ? renderOkfMessage(interpretationMessages, 'clarify_lead_in') : '');
        };
        if (release.knowledgeModel?.type === 'okf_release') {
          const checked = validateOkfGeneratedClaims(content, knowledgeGate?.claims.allowedClasses || []);
          if (!checked.valid) {
            // Never stream a sentence that asserts an unsupported claim. The rest of the reply is kept; if nothing is left, the question
            // or card still goes out with the tenant's own wording for "I can't confirm that".
            const withheld = withholdUnsupportedClaims(content, knowledgeGate?.claims.allowedClasses || []);
            console.warn(`[ClaimGuard] withheld ${withheld.removed.length} sentence(s) asserting ${[...new Set(withheld.removed.flatMap((entry) => entry.classes))].join(', ')} from the model reply; kept ${withheld.text ? 'the rest' : 'nothing'}. First withheld: "${withheld.removed[0]?.sentence.slice(0, 140)}"`);
            return {
              message: shape(withheld.text) || decision.payload?.question || knowledgeGate?.clarification?.question || renderOkfMessage(interpretationMessages, 'claim_withheld'),
              modelRoute: modelRes.route,
            };
          }
        }
        return {
          message: shape(content),
          modelRoute: modelRes.route,
        };
      }
    } catch (err: any) {
      // Model call unavailable or failed (e.g. offline testing without credentials).
      // Fallback to truthful grounded synthesis over verified documents or contextual clarification:
      if (isAskingForDetails && verifiedProducts.length > 0) {
        const topProd = verifiedProducts[0];
        const detailMessages = resolveInterpretationPolicy(release).messages;
        const priceStr = formatCatalogPrice(
          topProd.priceCents != null ? topProd.priceCents / 100 : topProd.price,
          topProd.currency || topProd.price?.currency || release.profile?.primaryCurrency,
          renderOkfMessage(detailMessages, 'price_on_request'),
        );
        return {
          message: renderOkfMessage(detailMessages, 'product_detail_fallback', {
            name: topProd.name || topProd.title || renderOkfMessage(detailMessages, 'product_default_name'),
            description: topProd.description || renderOkfMessage(detailMessages, 'product_default_description'),
            price: priceStr,
          }),
        };
      }

      if (verifiedDocs.length > 0) {
        const docSummaries = verifiedDocs
          .map((d) => d.content || d.summary)
          .filter(Boolean)
          .join('\n\n');

        const fallback = [
          docSummaries,
          renderOkfMessage(resolveInterpretationPolicy(release).messages, 'fallback_next_step'),
        ]
          .filter(Boolean)
          .join('\n\n');

        return { message: fallback };
      }

      // Check if user input looks like an ambiguous or mistyped measurement for an open dimension/measurement question
      const fallbackMessages = resolveInterpretationPolicy(release).messages;
      const isBareMeasurementAnswer = isAmbiguousMeasurementAnswer(customerQuestion);
      const isDimensionOpen = Array.isArray(openQuestionIds) && openQuestionIds.some((id: string) => resolveFactRole(release, id) === 'measurement');
      if (isBareMeasurementAnswer && isDimensionOpen) {
        return { message: renderOkfMessage(fallbackMessages, 'measurement_clarification') };
      }

      if (isDiscovery) {
        if (Array.isArray(decision.payload?.questions) && decision.payload.questions.length > 0) {
          const intro = (activeJourney as any)?.displayName
            ? renderOkfMessage(fallbackMessages, 'discovery_intro_named', { journeyName: activeJourney.displayName })
            : renderOkfMessage(fallbackMessages, 'discovery_intro');
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
          message: renderOkfMessage(fallbackMessages, 'discovery_default'),
        };
      }

      return {
        message: renderOkfMessage(fallbackMessages, 'no_verified_specs'),
      };
    }

    return {};
  }
}
