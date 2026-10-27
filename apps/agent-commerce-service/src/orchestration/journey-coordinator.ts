import { Injectable, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { TurnCommand, TurnResult } from '@journeyax/journey-core';
import { CanonicalRuntimeAdapter } from '../runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from '../runtime/tenant-runtime-activation.router';
import { LegacyJourneyAdapter } from '../legacy/legacy-journey-adapter';
import { ConfigLoader } from '../pipeline/config-loader';
import { ChatRequest, ChatResponse } from '../pipeline/types';

import { ReactAgentOrchestrator } from './react-agent-orchestrator';
import { principalIdFor } from '../identity';

/**
 * JourneyCoordinator
 *
 * Serves as:
 * - Routing boundary: delegates to autonomous ReactAgentOrchestrator
 * - Preserves canonical / legacy fallback paths
 */
@Injectable()
export class JourneyCoordinator {
  private static loggedRollbackWarning = false;

  constructor(
    @Inject(TenantRuntimeActivationRouter) private readonly activationRouter: TenantRuntimeActivationRouter,
    @Inject(CanonicalRuntimeAdapter) private readonly canonicalRuntime: CanonicalRuntimeAdapter,
    @Inject(LegacyJourneyAdapter) private readonly legacyAdapter: LegacyJourneyAdapter,
    @Inject(ConfigLoader) private readonly configLoader: ConfigLoader,
    @Optional() @Inject(ReactAgentOrchestrator) private readonly reactAgent?: ReactAgentOrchestrator
  ) {
    if (process.env.ENABLE_REACT_AGENT === 'true' && !JourneyCoordinator.loggedRollbackWarning) {
      console.warn(
        '[JourneyCoordinator] WARNING: ENABLE_REACT_AGENT=true is enabled as a rollback mechanism. Every chat turn will bypass the activation router and canonical runtime.'
      );
      JourneyCoordinator.loggedRollbackWarning = true;
    }
  }

  /**
   * Executes a buffered chat turn.
   */
  /** The connectors this person may use, for the chat's "+" menu. Never throws: no list means no menu entry, not a broken chat. */
  async listConnectors(tenantId: string, person: { sub?: string; role?: string; groups?: string[] } | undefined): Promise<{ connectors: any[]; packVersion?: string; welcome?: any }> {
    const tenant = (tenantId || '').toLowerCase().trim();
    if (!tenant) return { connectors: [] };
    try {
      return await this.canonicalRuntime.listConnectors(tenant, person);
    } catch (error: any) {
      console.warn(`[JourneyCoordinator] connector list unavailable for ${tenant}: ${String(error?.message || error).slice(0, 160)}`);
      return { connectors: [] };
    }
  }

  async executeChat(request: ChatRequest): Promise<ChatResponse> {
    const tenantId = (request.tenantId || '').toLowerCase().trim();
    if (!tenantId) {
      throw new Error('[JourneyCoordinator] Missing tenantId - failing closed: tenantId is required');
    }

    // Rollback mechanism: ONLY when ENABLE_REACT_AGENT is explicitly 'true'
    if (this.reactAgent && process.env.ENABLE_REACT_AGENT === 'true') {
      console.warn(`[JourneyCoordinator] Rollback: routing turn ${request.turnId || ''} to ReAct agent`);
      const response = await this.reactAgent.executeAgentTurnStream(request);
      return {
        ...response,
        engine: 'react',
        trace: [{ step: 'react_agent', detail: 'engine=react' }],
      } as any;
    }

    const env = ((request as any).environmentId || 'production') as string;
    const stableKey = request.sessionId || (request as any).workspaceId || tenantId;

    // Authoritative Release Activation & Traffic Policy
    const decision = await this.activationRouter.resolveActivation(tenantId, env, stableKey);

    if (decision.action === 'BLOCKED') {
      throw new ServiceUnavailableException(decision.reason);
    }

    if (decision.action === 'CANONICAL') {
      const workspaceId = request.workspaceId || request.sessionId || `ws_${Date.now()}`;
      const sessionId = request.sessionId || workspaceId;
      const turnId = request.turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const correlationId = request.correlationId || `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const idempotencyKey = request.idempotencyKey;
      const projectId = request.projectId || tenantId;
      const journeyId = request.journeyId;
      const environment = request.environment || request.environmentId || env;

      const command: TurnCommand = {
        tenantId,
        environmentId: env as any,
        workspaceId,
        sessionId,
        turnId,
        correlationId,
        principalId: principalIdFor((request as any).verifiedIdentity, request.demoPrincipalId || request.customerId),
        // The role and staff groups the gateway signed for this person; a request without a valid assertion is a shopper.
        principalRole: (request as any).verifiedIdentity?.role ?? 'customer',
        principalGroups: (request as any).verifiedIdentity?.groups,
        disabledConnectors: (request as any).disabledConnectors,
        message: request.message || (request.messages?.slice(-1)[0]?.content ?? ''),
        customerEvent: (request as any).customerEvent || (request as any).customer_event || (request as any).event,
        customer_event: (request as any).customer_event || (request as any).customerEvent,
        agentId: (request as any).agentId,
        parentMessageId: (request as any).parentMessageId,
        inputFacts: (request.state as any)?.facts || (request as any).inputFacts,
        idempotencyKey,
        projectId,
        journeyId,
        environment,
      };

      const turnResult = await this.canonicalRuntime.runTurn(command);

      // Convert canonical UI instructions into standard presentCard envelopes
      const uiActions = (turnResult.uiInstructions || []).map((inst) => {
        if (inst.envelope) {
          return inst.envelope;
        }
        return {
          name: 'presentCard',
          arguments: {
            card: {
              id: inst.actionId || `${inst.component}-${Date.now()}`,
              cardType: inst.component,
              state: inst.props,
            },
          },
        };
      });

      const engine = turnResult.trace?.engine || 'canonical';
      const agentId = turnResult.trace?.agentId;

      return {
        message: { role: 'assistant', content: turnResult.assistantMessage || '' },
        conversation: [
          ...(request.messages || []),
          { role: 'user', content: command.message },
          { role: 'assistant', content: turnResult.assistantMessage || '' },
        ],
        uiActions,
        sessionId: command.sessionId,
        engine,
        agentId,
        trace: turnResult.trace ? [{ step: 'canonical_turn', detail: `engine=${engine} stage=${turnResult.trace.stage || 'unknown'}` }] : undefined,
      } as any;
    }

    // ── LEGACY PATH: Unmigrated tenants / out-of-canary workspaces ──
    const legacyConfig = await this.configLoader.loadProjectConfig(tenantId);
    if (!legacyConfig) {
      throw new Error(`[JourneyCoordinator] No active configuration found for tenant "${tenantId}" - failing closed`);
    }

    const legacyResponse = await this.legacyAdapter.executeLegacyChat(request);
    return {
      ...legacyResponse,
      engine: 'legacy',
      trace: [{ step: 'legacy_turn', detail: 'engine=legacy' }],
    } as any;
  }

  /**
   * Streams a chat turn via Server-Sent Events.
   * Business Pack tenants stream directly from canonical runtime with zero buffering.
   */
  async executeChatStream(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<void> {
    const tenantId = (request.tenantId || '').toLowerCase().trim();
    if (!tenantId) {
      throw new Error('[JourneyCoordinator] Missing tenantId - failing closed: tenantId is required');
    }

    // Rollback mechanism: ONLY when ENABLE_REACT_AGENT is explicitly 'true'
    if (this.reactAgent && process.env.ENABLE_REACT_AGENT === 'true') {
      console.warn(`[JourneyCoordinator] Rollback: routing turn ${request.turnId || ''} to ReAct agent stream`);
      await this.reactAgent.executeAgentTurnStream(request, (event, data) => {
        if (event === 'done') {
          emit?.(event, { ...data, engine: 'react', trace: { ...(data?.trace || {}), engine: 'react' } });
        } else {
          emit?.(event, data);
        }
      });
      return;
    }

    const env = ((request as any).environmentId || 'production') as string;
    const stableKey = request.sessionId || (request as any).workspaceId || tenantId;

    // Authoritative Release Activation & Traffic Policy
    const decision = await this.activationRouter.resolveActivation(tenantId, env, stableKey);

    if (decision.action === 'BLOCKED') {
      throw new ServiceUnavailableException(decision.reason);
    }

    if (decision.action === 'CANONICAL') {
      const workspaceId = request.workspaceId || request.sessionId || `ws_${Date.now()}`;
      const sessionId = request.sessionId || workspaceId;
      const turnId = request.turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const correlationId = request.correlationId || `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const idempotencyKey = request.idempotencyKey;
      const projectId = request.projectId || tenantId;
      const journeyId = request.journeyId;
      const environment = request.environment || request.environmentId || env;

      const command: TurnCommand = {
        tenantId,
        environmentId: env as any,
        workspaceId,
        sessionId,
        turnId,
        correlationId,
        principalId: principalIdFor((request as any).verifiedIdentity, request.demoPrincipalId || request.customerId),
        // The role and staff groups the gateway signed for this person; a request without a valid assertion is a shopper.
        principalRole: (request as any).verifiedIdentity?.role ?? 'customer',
        principalGroups: (request as any).verifiedIdentity?.groups,
        disabledConnectors: (request as any).disabledConnectors,
        message: request.message || (request.messages?.slice(-1)[0]?.content ?? ''),
        customerEvent: (request as any).customerEvent || (request as any).customer_event || (request as any).event,
        customer_event: (request as any).customer_event || (request as any).customerEvent,
        agentId: (request as any).agentId,
        parentMessageId: (request as any).parentMessageId,
        inputFacts: (request.state as any)?.facts || (request as any).inputFacts,
        idempotencyKey,
        projectId,
        journeyId,
        environment,
      };

      await this.canonicalRuntime.streamTurn(command, (event, data) => {
        emit?.(event, data);
      });
      return;
    }

    // ── LEGACY PATH ──
    const legacyConfig = await this.configLoader.loadProjectConfig(tenantId);
    if (!legacyConfig) {
      throw new Error(`[JourneyCoordinator] No active configuration found for tenant "${tenantId}" - failing closed`);
    }

    return this.legacyAdapter.executeLegacyChatStream(request, emit);
  }
}
