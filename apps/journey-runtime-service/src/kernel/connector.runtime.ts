import {
  McpClientPool,
  type CapabilityDispatcher,
  type ExecutionContext,
  type ExecutionResponse,
  type McpClientProvider,
  type McpRequestMeta,
  type ToolBinding,
  type ToolDefinition,
} from '@journeyax/capability-sdk';
import {
  connectorToolState,
  mcpServerNameOf,
  usableConnectors,
  type ConnectorDefinition,
  type ConnectorState,
  type ConnectorsExtension,
} from '@journeyax/business-pack';
import type { Principal } from '@journeyax/shared-types';

/**
 * The runtime side of connectors: what the model may see of them, and the one gate every call goes through.
 *
 * The pack's registry (`extensions.connectors`) says which connectors exist and what each person may do with each tool; this class
 * lists them, loads a connector's tools from its MCP server only when asked, and hands a call to the dispatcher together with the
 * person's state for that tool (allow, ask first, blocked). It never sees a secret: the dispatcher's MCP client resolves the
 * connector's secret reference.
 */
export type ConnectorPerson = Pick<Principal, 'audience' | 'groups'>;

export interface ConnectorApprovalPort {
  createPending(toolId: string, input: unknown, ctx: ExecutionContext): Promise<{ approvalRequestId: string; expiresAt?: Date | string }>;
  getApproval(approvalRequestId: string): Promise<{ status: string; toolId: string; tenantId: string; workspaceId: string } | null>;
  consumeApproved(approvalRequestId: string, toolId: string, input: unknown, ctx: ExecutionContext): Promise<boolean>;
}

/** One line per call, with no arguments and no result: who, what, how it went. */
export interface ConnectorAuditEvent {
  tenantId: string;
  environmentId: string;
  principalId?: string;
  connectorId: string;
  tool: string;
  state: ConnectorState;
  outcome: 'success' | 'failed' | 'blocked' | 'needs_approval';
  durationMs: number;
  errorType?: string;
  correlationId: string;
}

export interface ConnectorRuntimeDeps {
  dispatcher: Pick<CapabilityDispatcher, 'dispatch'>;
  mcpClients: McpClientProvider;
  audit?: (event: ConnectorAuditEvent) => void;
  /** Most tools listed to the model for one connector. */
  maxToolsListed?: number;
}

export interface ConnectorSummary {
  connector: string;
  name: string;
  description: string;
  sample: boolean;
  tools: number;
}

/** The connectors this person can use at all, as the model is told about them: a name and a line. No tools. */
export function connectorSummaries(release: { extensions?: Record<string, any> } | undefined, person: ConnectorPerson): ConnectorSummary[] {
  return usableConnectors(release?.extensions?.connectors as ConnectorsExtension | undefined, person).map((connector) => ({
    connector: connector.connectorId,
    name: connector.displayName,
    description: connector.description,
    sample: Boolean(connector.sample),
    tools: connector.tools.filter((tool) => tool.state !== 'blocked').length,
  }));
}

const DEFAULT_MAX_TOOLS_LISTED = 30;

const SAMPLE_NOTICE = 'This connector runs on sample data, not on the live system. Say so when you use what it returns.';

export function connectorToolId(connectorId: string, tool: string): string {
  return `connector:${connectorId}.${tool}`;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function errorType(error: unknown): string {
  const message = String((error as any)?.message ?? error ?? '');
  if (/did not answer within/i.test(message)) return 'timeout';
  if (/not configured/i.test(message)) return 'not_configured';
  if (/Could not reach/i.test(message)) return 'unreachable';
  if (/HTTP 4\d\d/.test(message)) return 'rejected';
  if (/HTTP 5\d\d/.test(message)) return 'server_error';
  if (/reported an error/i.test(message)) return 'tool_error';
  if (/Secret/i.test(message)) return 'secret';
  return 'failed';
}

export class ConnectorRuntime {
  constructor(private readonly deps: ConnectorRuntimeDeps) {}

  private registryOf(release: { extensions?: Record<string, any> } | undefined): ConnectorsExtension | undefined {
    return release?.extensions?.connectors as ConnectorsExtension | undefined;
  }

  summaries(release: { extensions?: Record<string, any> } | undefined, person: ConnectorPerson): ConnectorSummary[] {
    return connectorSummaries(release, person);
  }

  private find(release: { extensions?: Record<string, any> } | undefined, connectorId: string, person: ConnectorPerson): ConnectorDefinition | undefined {
    const registry = this.registryOf(release);
    const connector = registry?.connectors.find((entry) => entry.connectorId === connectorId);
    if (!connector || connector.enabled === false) return undefined;
    return usableConnectors(registry, person).some((entry) => entry.connectorId === connectorId) ? connector : undefined;
  }

  private notFound(release: { extensions?: Record<string, any> } | undefined, connectorId: string, person: ConnectorPerson) {
    return {
      ok: false as const,
      status: 'not_found' as const,
      error: `There is no connector "${connectorId}" available to you.`,
      available: this.summaries(release, person).map((summary) => summary.connector),
    };
  }

  /**
   * Loads one connector's tools from its MCP server (the first time; the client reuses the list for a few minutes). A tool is shown only if
   * the pack lists it and this person's state for it is not blocked. A tool the server offers that the pack does not list is new: it starts
   * blocked and is only counted.
   */
  async loadTools(
    release: { extensions?: Record<string, any> } | undefined,
    person: ConnectorPerson,
    ctx: ExecutionContext,
    connectorId: string,
    query?: string,
  ) {
    const connector = this.find(release, connectorId, person);
    if (!connector) return this.notFound(release, connectorId, person);
    const registry = this.registryOf(release)!;
    let offered;
    try {
      const client = await this.deps.mcpClients.getClient(mcpServerNameOf(connector), {
        tenantId: ctx.tenantId,
        environmentId: ctx.environmentId,
        connectionRef: connector.connectionRef,
        secretRef: connector.secretRef,
      });
      offered = await client.listTools(metaOf(ctx, connector));
    } catch (err) {
      return { ok: false as const, status: 'failed' as const, connector: connectorId, error: `Could not load the tools of "${connector.displayName}": ${String((err as any)?.message || err).slice(0, 200)}` };
    }

    const visible = [];
    let hidden = 0;
    for (const descriptor of offered) {
      const listed = connector.tools.find((tool) => tool.name === descriptor.name);
      const { state } = connectorToolState(registry, connector.connectorId, descriptor.name, person);
      if (!listed || state === 'blocked') { hidden++; continue; }
      visible.push({
        name: descriptor.name,
        description: descriptor.description || listed.summary || '',
        inputSchema: descriptor.inputSchema,
        asksFirst: state === 'ask',
        changesData: listed.sideEffect === 'write',
      });
    }

    const wanted = tokens(query || '');
    const matched = wanted.length === 0 ? visible : visible.filter((tool) => {
      const haystack = tokens(`${tool.name} ${tool.description}`);
      return wanted.every((token) => haystack.some((word) => word.startsWith(token) || token.startsWith(word)));
    });
    const chosen = matched.length > 0 ? matched : visible;
    const limit = this.deps.maxToolsListed ?? DEFAULT_MAX_TOOLS_LISTED;
    return {
      ok: true as const,
      connector: connectorId,
      name: connector.displayName,
      sample: Boolean(connector.sample),
      ...(connector.sample ? { notice: SAMPLE_NOTICE } : {}),
      tools: chosen.slice(0, limit),
      ...(wanted.length > 0 && matched.length === 0 ? { note: `No tool matched "${query}"; these are all the tools you can use.` } : {}),
      ...(chosen.length > limit ? { more: chosen.length - limit } : {}),
      hidden,
    };
  }

  /**
   * Calls one tool through the dispatcher and the policy gate. `approvalRequestId` is the id of an approval a person gave for this exact
   * call; it is spent once. The model cannot approve its own call: the confirmation is set here, only after the approval store agrees.
   */
  async call(
    release: { extensions?: Record<string, any>; manifest?: { packId?: string; version?: string } } | undefined,
    person: ConnectorPerson,
    ctx: ExecutionContext,
    connectorId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { approvals?: ConnectorApprovalPort; approvalRequestId?: string; /** The person has just allowed this exact call on an ask-first card; set only by the server. */ confirmedByPerson?: boolean } = {},
  ) {
    const registry = this.registryOf(release);
    // A connector none of whose tools this person may use does not exist for them.
    const connector = this.find(release, connectorId, person);
    const started = Date.now();
    const audit = (state: ConnectorState, outcome: ConnectorAuditEvent['outcome'], error?: unknown) =>
      this.deps.audit?.({
        tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId, connectorId, tool: toolName,
        state, outcome, durationMs: Date.now() - started, correlationId: ctx.correlationId, ...(error ? { errorType: errorType(error) } : {}),
      });

    if (!connector) {
      audit('blocked', 'blocked');
      return this.notFound(release, connectorId, person);
    }
    const { state, known } = connectorToolState(registry, connectorId, toolName, person);
    const listed = connector.tools.find((tool) => tool.name === toolName);
    const toolId = connectorToolId(connectorId, toolName);
    const definition = {
      toolId, version: '1.0.0', displayName: `${connector.displayName}: ${toolName}`, description: listed?.summary ?? toolName,
      inputSchema: {}, outputSchema: {}, sideEffect: listed?.sideEffect ?? 'read', risk: 'low',
    } as unknown as ToolDefinition;
    const binding = {
      toolId, tenantId: ctx.tenantId, environmentId: ctx.environmentId, bindingVersion: '1.0.0', enabled: true,
      executor: {
        type: 'mcp_tool', mcpServerName: mcpServerNameOf(connector), mcpToolName: toolName,
        ...(connector.secretRef ? { secretRef: connector.secretRef } : {}),
        ...(connector.connectionRef ? { connectionRef: connector.connectionRef } : {}),
      },
    } as unknown as ToolBinding;

    // An approval given for this exact call is spent here; only then is the call confirmed.
    let confirmed = state === 'ask' && options.confirmedByPerson === true;
    if (!confirmed && state === 'ask' && options.approvalRequestId && options.approvals) {
      confirmed = await options.approvals.consumeApproved(options.approvalRequestId, toolId, args, ctx).catch(() => false);
    }

    const response: ExecutionResponse = await this.deps.dispatcher.dispatch(
      definition,
      binding,
      { toolId, input: args, policyState: state, userConfirmationConfirmed: confirmed, idempotencyKey: ctx.idempotencyKey },
      ctx,
    );

    if (response.status === 'denied') {
      audit(state, 'blocked');
      return {
        ok: false as const, status: 'blocked' as const, connector: connectorId, tool: toolName,
        error: known ? `"${toolName}" on "${connector.displayName}" is blocked for you.` : `"${toolName}" is not a tool you can use on "${connector.displayName}".`,
      };
    }

    if (response.status === 'requires_approval') {
      let approvalRequestId = response.approvalRequestId;
      let expiresAt: string | undefined;
      let waiting = false;
      if (options.approvals) {
        // An id that is still waiting for a decision is reported again, not replaced.
        const existing = options.approvalRequestId ? await options.approvals.getApproval(options.approvalRequestId).catch(() => null) : null;
        if (existing && existing.status === 'pending' && existing.toolId === toolId && existing.tenantId === ctx.tenantId) {
          approvalRequestId = options.approvalRequestId;
          waiting = true;
        } else {
          const pending = await options.approvals.createPending(toolId, args, ctx);
          approvalRequestId = pending.approvalRequestId;
          expiresAt = pending.expiresAt ? new Date(pending.expiresAt).toISOString() : undefined;
        }
      }
      audit(state, 'needs_approval');
      return {
        ok: false as const, status: 'needs_approval' as const, connector: connectorId, tool: toolName, arguments: args,
        approvalRequestId, ...(expiresAt ? { expiresAt } : {}),
        message: waiting
          ? `Still waiting for a person to approve "${toolName}" on "${connector.displayName}". Nothing has been done yet.`
          : `"${toolName}" on "${connector.displayName}" needs a person's approval before it runs. Nothing has been done yet. Tell the person what is waiting; when they have approved, call again with this approvalRequestId and the same arguments.`,
      };
    }

    if (response.status !== 'success') {
      audit(state, 'failed', response.error);
      return {
        ok: false as const, status: 'failed' as const, connector: connectorId, tool: toolName,
        error: String(response.error || 'The call failed.').slice(0, 300),
      };
    }

    audit(state, 'success');
    const output = (response.output ?? {}) as { text?: string; data?: unknown; truncated?: boolean; omitted?: number };
    return {
      ok: true as const,
      connector: connectorId,
      tool: toolName,
      sample: Boolean(connector.sample),
      ...(connector.sample ? { notice: SAMPLE_NOTICE } : {}),
      result: output.data !== undefined ? output.data : output.text ?? '',
      ...(output.truncated ? { truncated: true, ...(output.omitted ? { omitted: output.omitted } : {}) } : {}),
      claimClasses: listed?.claimClasses ?? [],
    };
  }
}

function metaOf(ctx: ExecutionContext, connector: ConnectorDefinition): McpRequestMeta {
  return { tenantId: ctx.tenantId, environmentId: ctx.environmentId, correlationId: ctx.correlationId, principalId: ctx.principalId, connectionRef: connector.connectionRef };
}

/** The gateway builds one of these from its own dispatcher and client pool. */
export function createConnectorRuntime(dispatcher: Pick<CapabilityDispatcher, 'dispatch'>, mcpClients: McpClientPool | McpClientProvider, audit?: ConnectorRuntimeDeps['audit']): ConnectorRuntime {
  return new ConnectorRuntime({ dispatcher, mcpClients, audit });
}
