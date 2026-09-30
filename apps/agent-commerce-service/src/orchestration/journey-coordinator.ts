import { Injectable, Inject, ServiceUnavailableException } from '@nestjs/common';
import { TurnCommand, TurnResult } from '@journeyax/journey-core';
import { CanonicalRuntimeAdapter } from '../runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from '../runtime/tenant-runtime-activation.router';
import { LegacyJourneyAdapter } from '../legacy/legacy-journey-adapter';
import { ConfigLoader } from '../pipeline/config-loader';
import { ChatRequest, ChatResponse } from '../pipeline/types';

/**
 * JourneyCoordinator
 *
 * Serves strictly as:
 * - HTTP compatibility façade & tenant propagation adapter
 * - Routing boundary: delegates Business Pack tenants to canonical Journey Runtime
 * - Isolates legacy compatibility for genuinely unmigrated tenants
 * - Pure streaming pass-through to canonical /runtime/chat/stream
 *
 * Invariant: Never executes a parallel model/tool loop for canonical tenants.
 */
@Injectable()
export class JourneyCoordinator {
  constructor(
    @Inject(TenantRuntimeActivationRouter) private readonly activationRouter: TenantRuntimeActivationRouter,
    @Inject(CanonicalRuntimeAdapter) private readonly canonicalRuntime: CanonicalRuntimeAdapter,
    @Inject(LegacyJourneyAdapter) private readonly legacyAdapter: LegacyJourneyAdapter,
    @Inject(ConfigLoader) private readonly configLoader: ConfigLoader
  ) {}

  /**
   * Executes a buffered chat turn.
   */
  async executeChat(request: ChatRequest): Promise<ChatResponse> {
    const tenantId = (request.tenantId || '').toLowerCase().trim();
    if (!tenantId) {
      throw new Error('[JourneyCoordinator] Missing tenantId - failing closed: tenantId is required');
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
        principalId: request.demoPrincipalId || request.customerId || 'anonymous',
        principalRole: 'customer',
        message: request.message || (request.messages?.slice(-1)[0]?.content ?? ''),
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

      return {
        message: { role: 'assistant', content: turnResult.assistantMessage || '' },
        conversation: [
          ...(request.messages || []),
          { role: 'user', content: command.message },
          { role: 'assistant', content: turnResult.assistantMessage || '' },
        ],
        uiActions,
        sessionId: command.sessionId,
        trace: turnResult.trace ? [{ step: 'canonical_turn', detail: `stage=${turnResult.trace.stage || 'unknown'}` }] : undefined,
      };
    }

    // ── LEGACY PATH: Unmigrated tenants / out-of-canary workspaces ──
    const legacyConfig = await this.configLoader.loadProjectConfig(tenantId);
    if (!legacyConfig) {
      throw new Error(`[JourneyCoordinator] No active configuration found for tenant "${tenantId}" - failing closed`);
    }

    return this.legacyAdapter.executeLegacyChat(request);
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
        principalId: request.demoPrincipalId || request.customerId || 'anonymous',
        principalRole: 'customer',
        message: request.message || (request.messages?.slice(-1)[0]?.content ?? ''),
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
