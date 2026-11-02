import { Injectable, Inject, ServiceUnavailableException } from '@nestjs/common';
import { TurnCommand } from '@journeyax/journey-core';
import { CanonicalRuntimeAdapter } from '../runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from '../runtime/tenant-runtime-activation.router';
import { ChatRequest, ChatResponse } from '../pipeline/types';

import { principalIdFor } from '../identity';

/**
 * JourneyCoordinator
 *
 * Routing boundary: asks the activation router which release serves the tenant, then hands the turn to the
 * canonical Journey Runtime. A tenant with no approved activation record is refused (503), never served by
 * another engine.
 */
@Injectable()
export class JourneyCoordinator {
  constructor(
    @Inject(TenantRuntimeActivationRouter) private readonly activationRouter: TenantRuntimeActivationRouter,
    @Inject(CanonicalRuntimeAdapter) private readonly canonicalRuntime: CanonicalRuntimeAdapter,
  ) {}

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

  /** The corner tile and dashboard for this person. Never throws: no dashboard means no tile, not a broken chat. */
  async getDashboard(tenantId: string, person: { sub?: string; role?: string; groups?: string[] } | undefined): Promise<{ dashboard?: any }> {
    const tenant = (tenantId || '').toLowerCase().trim();
    if (!tenant) return {};
    try {
      return await this.canonicalRuntime.getDashboard(tenant, person);
    } catch (error: any) {
      console.warn(`[JourneyCoordinator] dashboard unavailable for ${tenant}: ${String(error?.message || error).slice(0, 160)}`);
      return {};
    }
  }

  /** Asks the activation router about this tenant; anything but an approved canonical release is refused with 503. */
  private async resolveCanonical(request: ChatRequest): Promise<{ tenantId: string; env: string }> {
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
    if (decision.action !== 'CANONICAL') {
      throw new ServiceUnavailableException(
        `[ReleaseActivation] Tenant '${tenantId}' is not served by the canonical runtime (${decision.reason}). No other engine is available.`
      );
    }
    return { tenantId, env };
  }

  private buildTurnCommand(request: ChatRequest, tenantId: string, env: string): TurnCommand {
    const workspaceId = request.workspaceId || request.sessionId || `ws_${Date.now()}`;
    const sessionId = request.sessionId || workspaceId;
    const turnId = request.turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const correlationId = request.correlationId || `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const idempotencyKey = request.idempotencyKey;
    const projectId = request.projectId || tenantId;
    const journeyId = request.journeyId;
    const environment = request.environment || request.environmentId || env;

    return {
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
  }

  /**
   * Executes a buffered chat turn.
   */
  async executeChat(request: ChatRequest): Promise<ChatResponse> {
    const { tenantId, env } = await this.resolveCanonical(request);
    const command = this.buildTurnCommand(request, tenantId, env);

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

  /**
   * Streams a chat turn via Server-Sent Events, straight from the canonical runtime with zero buffering.
   */
  async executeChatStream(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<void> {
    const { tenantId, env } = await this.resolveCanonical(request);
    const command = this.buildTurnCommand(request, tenantId, env);

    await this.canonicalRuntime.streamTurn(command, (event, data) => {
      emit?.(event, data);
    });
  }
}
