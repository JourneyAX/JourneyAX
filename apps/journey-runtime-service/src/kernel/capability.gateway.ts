import {
  CapabilityDispatcher,
  CapabilityResolver,
  EnvMcpServerDirectory,
  McpClientPool,
  NativeCapabilityHandler,
  ExecutionContext,
  ExecutionResponse,
  type McpClientProvider,
  type SecretResolver,
} from '@journeyax/capability-sdk';
import { BusinessPackRelease } from '@journeyax/business-pack';
import { WorkspaceState } from '@journeyax/journey-core';
import {
  CatalogSearchHandler,
  PricingValidateHandler,
  OrderCommitHandler,
  KnowledgeSearchHandler,
  BranchStockCheckHandler,
  TradeQuoteCreateHandler,
  ItemConfigureHandler,
  CartUpdateHandler,
  SpecificationConfigureHandler,
  QuoteUpdateHandler,
  SpacePlannerHandler,
  ProjectPlanHandler,
} from '../capabilities/handlers';

import { ConnectorRuntime, type ConnectorAuditEvent } from './connector.runtime';
import type { KnowledgeRetrievalPortResolver, LegacyKnowledgeRetrievalPortResolver } from './knowledge-retrieval.port';
import {
  IConnectionOwnershipRepository,
  DurableConnectionOwnershipRepository,
} from './connection-ownership.repository';

export interface CapabilityGatewayOptions {
  /** Injected canonical knowledge-retrieval port (composition root). Absent => knowledge.search returns a typed unavailable result. */
  knowledgePortResolver?: KnowledgeRetrievalPortResolver;
  legacyKnowledgePortResolver?: LegacyKnowledgeRetrievalPortResolver;
  ownershipRepository?: IConnectionOwnershipRepository;
  db?: any;
  activepiecesApiUrl?: string;
  activepiecesApiKey?: string;
  activepiecesWebhookSecret?: string;
  /** Where `mcp_tool` calls get their client. Default: a pool over the servers named in CONNECTOR_MCP_SERVERS / CONNECTOR_MCP_BASE_URL. */
  mcpClients?: McpClientProvider;
  /** Turns a connector's secret reference into the secret. Default: the development resolver (CONNECTOR_SECRET_<NAME>). */
  secretResolver?: SecretResolver;
  /** Receives one event per connector call (no arguments, no results). */
  connectorAudit?: (event: ConnectorAuditEvent) => void;
}

export class CapabilityGateway {
  private dispatcher: CapabilityDispatcher;
  private resolver: CapabilityResolver;
  private ownershipRepository: IConnectionOwnershipRepository;
  private connectorRuntime: ConnectorRuntime;

  constructor(options: CapabilityGatewayOptions = {}) {
    this.ownershipRepository =
      options.ownershipRepository ||
      new DurableConnectionOwnershipRepository(options.db ? () => options.db : undefined);

    const mcpClients = options.mcpClients || new McpClientPool({ directory: new EnvMcpServerDirectory(), secrets: options.secretResolver });
    this.dispatcher = new CapabilityDispatcher({
      mcpClients,
      activepiecesApiUrl: options.activepiecesApiUrl || process.env.ACTIVEPIECES_API_URL,
      activepiecesApiKey: options.activepiecesApiKey || process.env.ACTIVEPIECES_API_KEY,
      activepiecesWebhookSecret:
        options.activepiecesWebhookSecret || process.env.ACTIVEPIECES_WEBHOOK_SECRET,
      validateConnectionOwnership: (tenantId, environmentId, connectionRef) =>
        this.ownershipRepository.validateOwnership(tenantId, environmentId, connectionRef),
    });
    this.resolver = new CapabilityResolver();
    this.connectorRuntime = new ConnectorRuntime({ dispatcher: this.dispatcher, mcpClients, audit: options.connectorAudit });

    // Register generic domain-neutral platform handlers
    this.dispatcher.registerNativeHandler('catalog.search', new CatalogSearchHandler());
    this.dispatcher.registerNativeHandler('catalog-search', new CatalogSearchHandler());
    this.dispatcher.registerNativeHandler('products', new CatalogSearchHandler());
    this.dispatcher.registerNativeHandler('pricing.validate', new PricingValidateHandler());
    this.dispatcher.registerNativeHandler('order.commit', new OrderCommitHandler());
    this.dispatcher.registerNativeHandler('knowledge.search', new KnowledgeSearchHandler(undefined, options.knowledgePortResolver, options.legacyKnowledgePortResolver));
    this.dispatcher.registerNativeHandler('installGuide', new KnowledgeSearchHandler(undefined, options.knowledgePortResolver, options.legacyKnowledgePortResolver));
    this.dispatcher.registerNativeHandler('branch.stock_check', new BranchStockCheckHandler());
    this.dispatcher.registerNativeHandler('checkBranchStock', new BranchStockCheckHandler());
    this.dispatcher.registerNativeHandler('trade.quote_create', new TradeQuoteCreateHandler());
    this.dispatcher.registerNativeHandler('quote', new TradeQuoteCreateHandler());
    this.dispatcher.registerNativeHandler('item.configure', new ItemConfigureHandler());
    this.dispatcher.registerNativeHandler('item-configure', new ItemConfigureHandler());
    this.dispatcher.registerNativeHandler('openSpacePlanner', new SpacePlannerHandler());
    this.dispatcher.registerNativeHandler('spacePlanner.open', new SpacePlannerHandler());
    this.dispatcher.registerNativeHandler('space-planner', new SpacePlannerHandler());
    this.dispatcher.registerNativeHandler('cart.update', new CartUpdateHandler());
    this.dispatcher.registerNativeHandler('cart-update', new CartUpdateHandler());
    this.dispatcher.registerNativeHandler('specification.configure', new SpecificationConfigureHandler());
    this.dispatcher.registerNativeHandler('specification-configure', new SpecificationConfigureHandler());
    this.dispatcher.registerNativeHandler('buildProjectPlan', new ProjectPlanHandler());
    this.dispatcher.registerNativeHandler('projectPlan.build', new ProjectPlanHandler());
    this.dispatcher.registerNativeHandler('project-plan', new ProjectPlanHandler());
    this.dispatcher.registerNativeHandler('quote.update', new QuoteUpdateHandler());
    this.dispatcher.registerNativeHandler('quote-update', new QuoteUpdateHandler());
  }

  /** Reaches the connectors a pack declares (other systems over MCP), through this gateway's dispatcher and policy gate. */
  getConnectorRuntime(): ConnectorRuntime {
    return this.connectorRuntime;
  }

  getOwnershipRepository(): IConnectionOwnershipRepository {
    return this.ownershipRepository;
  }

  /**
   * Register a custom or tenant-specific adapter dynamically without modifying core imports.
   */
  registerCustomAdapter(toolId: string, handler: NativeCapabilityHandler): void {
    this.dispatcher.registerNativeHandler(toolId, handler);
  }

  getNativeHandler(toolId: string): NativeCapabilityHandler | undefined {
    return this.dispatcher.getNativeHandler(toolId);
  }

  /**
   * Resolves permitted stage-scoped capabilities for the current turn.
   */
  resolveCapabilitiesForStage(
    release: BusinessPackRelease,
    workspace: WorkspaceState
  ) {
    if (!workspace || !workspace.journeyId) {
      return [];
    }
    const journey = release.journeys.find((j) => j.journeyId === workspace.journeyId);
    if (!journey) {
      return [];
    }
    const stageId = workspace.currentStage || journey.initialStage;
    if (!stageId) {
      return [];
    }

    const toolDefs = release.capabilities?.toolDefinitions || [];
    const toolBindings = release.capabilities?.toolBindings || [];
    const stageBindings = release.capabilities?.stageBindings || [];

    return this.resolver.resolveForStage(
      journey.journeyId,
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
      {
        ...ctx,
        release,
        vocabulary: (release as any).vocabulary,
        packSettings: {
          ...ctx.packSettings,
          catalogMapping: (release as any).catalogMapping,
          vocabulary: (release as any).vocabulary,
          extensions: (release as any).extensions,
        },
      }
    );
  }
}
