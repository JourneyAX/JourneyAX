import {
  CapabilityDispatcher,
  CapabilityResolver,
  NativeCapabilityHandler,
  ExecutionContext,
  ExecutionResponse,
} from '@journeyax/capability-sdk';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState } from '@journeyax/journey-core';
import {
  CatalogSearchHandler,
  PricingValidateHandler,
  OrderCommitHandler,
} from '../capabilities/handlers';

export class CapabilityGateway {
  private dispatcher: CapabilityDispatcher;
  private resolver: CapabilityResolver;

  constructor() {
    this.dispatcher = new CapabilityDispatcher();
    this.resolver = new CapabilityResolver();

    // Register generic domain-neutral platform handlers
    this.dispatcher.registerNativeHandler('catalog.search', new CatalogSearchHandler());
    this.dispatcher.registerNativeHandler('pricing.validate', new PricingValidateHandler());
    this.dispatcher.registerNativeHandler('order.commit', new OrderCommitHandler());
  }

  /**
   * Register a custom or tenant-specific adapter dynamically without modifying core imports.
   */
  registerCustomAdapter(toolId: string, handler: NativeCapabilityHandler): void {
    this.dispatcher.registerNativeHandler(toolId, handler);
  }

  /**
   * Resolves permitted stage-scoped capabilities for the current turn.
   */
  resolveCapabilitiesForStage(
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ) {
    const journey = release.journeys.find((j) => j.journeyId === workspace.journeyId) || release.journeys[0];
    const stageId = workspace.currentStage || journey?.initialStage || 'entry';

    const toolDefs = release.capabilities?.toolDefinitions || [];
    const toolBindings = release.capabilities?.toolBindings || [];
    const stageBindings = release.capabilities?.stageBindings || [];

    return this.resolver.resolveForStage(
      journey?.journeyId || 'default',
      stageId,
      toolDefs,
      toolBindings,
      stageBindings,
      workspace.facts,
      workspace.tenantId,
      workspace.environmentId
    );
  }

  /**
   * Dispatches capability execution via policy gate and registered adapters.
   */
  async executeCapability(
    release: BusinessPackRelease,
    toolId: string,
    payload: Record<string, any>,
    ctx: ExecutionContext
  ): Promise<ExecutionResponse> {
    const toolDef = release.capabilities?.toolDefinitions?.find((t) => t.toolId === toolId);
    if (!toolDef) {
      return {
        toolId,
        status: 'failure',
        error: `Tool definition '${toolId}' not declared in Business Pack '${release.manifest.packId}'`,
        durationMs: 0,
        provenance: {
          executorType: 'policy-gate',
          executedAt: new Date().toISOString(),
          correlationId: ctx.correlationId,
        },
      };
    }

    const toolBinding = release.capabilities?.toolBindings?.find(
      (b) =>
        b.toolId === toolId &&
        (!b.tenantId || b.tenantId === ctx.tenantId) &&
        (!b.environmentId || b.environmentId === ctx.environmentId)
    );

    if (!toolBinding) {
      return {
        toolId,
        status: 'failure',
        error: `No tool binding configured for '${toolId}' in tenant '${ctx.tenantId}' (${ctx.environmentId})`,
        durationMs: 0,
        provenance: {
          executorType: 'policy-gate',
          executedAt: new Date().toISOString(),
          correlationId: ctx.correlationId,
        },
      };
    }

    return this.dispatcher.dispatch(
      toolDef,
      toolBinding,
      { toolId, input: payload, idempotencyKey: ctx.correlationId },
      ctx
    );
  }
}
