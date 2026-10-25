import { resolveServiceUrl } from '@journeyax/shared-types';
import { createHmac, randomUUID } from 'crypto';
import {
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResponse,
  NativeCapabilityHandler,
} from './types';
import { PolicyGate } from './policy-gate';
import type { McpClientProvider } from './mcp/pool';

export interface DispatcherOptions {
  activepiecesApiUrl?: string;
  activepiecesApiKey?: string;
  activepiecesWebhookSecret?: string;
  validateConnectionOwnership?: (tenantId: string, environmentId: string, connectionRef: string) => Promise<boolean> | boolean;
  /** Where `mcp_tool` bindings get their client. Absent: an `mcp_tool` call fails closed. */
  mcpClients?: McpClientProvider;
}

export class CapabilityDispatcher {
  private nativeHandlers = new Map<string, NativeCapabilityHandler>();
  private policyGate = new PolicyGate();

  constructor(private options: DispatcherOptions = {}) {}

  /**
   * Register an in-process native capability handler (e.g. Catalog search, Price validation).
   */
  registerNativeHandler(name: string, handler: NativeCapabilityHandler): void {
    this.nativeHandlers.set(name, handler);
  }

  getNativeHandler(name: string): NativeCapabilityHandler | undefined {
    return this.nativeHandlers.get(name);
  }

  /**
   * Dispatches execution according to the ToolBinding executor definition.
   */
  async dispatch(
    tool: ToolDefinition,
    binding: ToolBinding,
    request: ExecutionRequest,
    ctx: ExecutionContext
  ): Promise<ExecutionResponse> {
    const startTime = Date.now();
    const effectiveCtx: ExecutionContext = {
      ...ctx,
      idempotencyKey: request.idempotencyKey || ctx.idempotencyKey,
    };

    // 1. Enforce policy gate (roles, approval, idempotency)
    const policyResult = this.policyGate.checkPolicy(tool, binding, request, effectiveCtx);
    if (!policyResult.allowed) {
      if (policyResult.requiresApproval) {
        return {
          toolId: tool.toolId,
          status: 'requires_approval',
          error: policyResult.reason,
          durationMs: Date.now() - startTime,
          approvalRequestId: `apr_${effectiveCtx.workspaceId}_${Date.now()}`,
          provenance: {
            executorType: binding.executor?.type || 'native_capability',
            executedAt: new Date().toISOString(),
            correlationId: effectiveCtx.correlationId,
          },
        };
      }
      return {
        toolId: tool.toolId,
        status: 'denied',
        error: policyResult.reason,
        durationMs: Date.now() - startTime,
        provenance: {
          executorType: binding.executor?.type || 'native_capability',
          executedAt: new Date().toISOString(),
          correlationId: effectiveCtx.correlationId,
        },
      };
    }

    try {
      const executor = binding.executor || {
        type: 'native_capability' as const,
        nativeHandler: (binding as any).adapterRef || tool.toolId,
      };
      let output: any;

      switch (executor.type) {
        case 'native_capability': {
          const handlerKey = executor.nativeHandler || tool.toolId;
          const handler =
            this.nativeHandlers.get(handlerKey) ||
            this.nativeHandlers.get(tool.toolId) ||
            this.nativeHandlers.get(handlerKey.replace(/-/g, '.')) ||
            this.nativeHandlers.get(handlerKey.replace(/\./g, '-'));
          if (!handler) {
            throw new Error(`No native capability handler registered for '${handlerKey}'`);
          }
          output = await handler.execute(request.input, effectiveCtx);
          break;
        }

        case 'activepieces_flow': {
          // Dispatches to external Activepieces flow
          output = await this.invokeActivepiecesFlow(
            executor.flowId!,
            request.input,
            effectiveCtx,
            (executor as any).connectionRef
          );
          break;
        }

        case 'mcp_tool': {
          output = await this.invokeMcpTool(executor as any, tool, request.input, effectiveCtx);
          break;
        }

        default:
          throw new Error(`Unsupported executor type: ${executor.type}`);
      }

      return {
        toolId: tool.toolId,
        status: 'success',
        output,
        durationMs: Date.now() - startTime,
        provenance: {
          executorType: executor.type,
          executedAt: new Date().toISOString(),
          correlationId: ctx.correlationId,
        },
      };
    } catch (err: any) {
      return {
        toolId: tool.toolId,
        status: 'failure',
        error: err.message || 'Capability execution failed',
        durationMs: Date.now() - startTime,
        provenance: {
          executorType: binding.executor.type,
          executedAt: new Date().toISOString(),
          correlationId: ctx.correlationId,
        },
      };
    }
  }

  /**
   * A connection reference must be well formed and owned by the calling tenant and environment. Fails closed: with no validator
   * configured a call that names a connection does not run.
   */
  private async assertConnectionOwned(label: string, connectionRef: string | undefined | null, tenantId: string, environmentId: string): Promise<void> {
    if (connectionRef === undefined || connectionRef === null) return;
    const normConn = connectionRef.trim();
    if (!normConn || !/^[a-zA-Z0-9_.\-]+$/.test(normConn)) {
      throw new Error(`${label} failed: invalid connectionRef '${connectionRef}'`);
    }
    if (!this.options.validateConnectionOwnership) {
      throw new Error(
        `${label} failed: validateConnectionOwnership validator is mandatory when connectionRef is provided; failing closed`
      );
    }
    let isOwner: boolean;
    try {
      isOwner = await this.options.validateConnectionOwnership(tenantId, environmentId, normConn);
    } catch (err: any) {
      throw new Error(`${label} failed: connectionRef ownership validation error: ${err.message || err}`);
    }
    if (!isOwner) {
      throw new Error(`${label} failed: connectionRef '${normConn}' not owned by tenant '${tenantId}' (${environmentId})`);
    }
  }

  /**
   * Calls a tool on an MCP server. The server is named, never addressed, in the binding; its address and the secret it is called with
   * are resolved by the client provider from configuration and a secret reference. The result is capped in size and scrubbed of secrets.
   */
  private async invokeMcpTool(
    executor: { mcpServerName?: string; mcpToolName?: string; connectionRef?: string; secretRef?: string },
    tool: ToolDefinition,
    input: any,
    ctx: ExecutionContext
  ): Promise<any> {
    const tenantId = (ctx.tenantId || '').trim();
    const environmentId = (ctx.environmentId || '').trim();
    const serverName = (executor.mcpServerName || '').trim();
    const toolName = (executor.mcpToolName || tool.toolId || '').trim();
    if (!tenantId) throw new Error('MCP dispatch failed: tenantId is required');
    if (!environmentId) throw new Error('MCP dispatch failed: environmentId is required');
    if (!serverName || !/^[a-zA-Z0-9_\-]+$/.test(serverName)) throw new Error(`MCP dispatch failed: invalid or missing mcpServerName '${executor.mcpServerName}'`);
    if (!toolName || !/^[A-Za-z0-9][A-Za-z0-9_\-.]*$/.test(toolName)) throw new Error(`MCP dispatch failed: invalid tool name '${toolName}'`);
    if (!this.options.mcpClients) throw new Error('MCP dispatch failed: no MCP client is configured; failing closed');

    await this.assertConnectionOwned('MCP dispatch', executor.connectionRef, tenantId, environmentId);
    const connectionRef = executor.connectionRef?.trim() || undefined;

    const client = await this.options.mcpClients.getClient(serverName, { tenantId, environmentId, connectionRef, secretRef: executor.secretRef });
    const result = await client.callTool(toolName, input && typeof input === 'object' ? input : {}, {
      tenantId,
      environmentId,
      correlationId: ctx.correlationId,
      principalId: ctx.principalId,
      connectionRef,
    });
    if (result.isError) {
      throw new Error(`The tool '${toolName}' on '${serverName}' reported an error: ${result.text || 'no detail given'}`.slice(0, 400));
    }
    const { isError: _isError, ...output } = result;
    return output;
  }

  private async invokeActivepiecesFlow(
    flowId: string,
    input: any,
    ctx: ExecutionContext,
    connectionRef?: string
  ): Promise<any> {
    // 1. Validate tenant, environment, and flow identifiers
    const normTenant = (ctx.tenantId || '').trim();
    const normEnv = (ctx.environmentId || '').trim();
    const normFlow = (flowId || '').trim();

    if (!normTenant) {
      throw new Error('Activepieces dispatch failed: tenantId is required');
    }
    if (!normEnv) {
      throw new Error('Activepieces dispatch failed: environmentId is required');
    }
    if (!normFlow || !/^[a-zA-Z0-9_\-]+$/.test(normFlow)) {
      throw new Error(`Activepieces dispatch failed: invalid or missing flowId '${flowId}'`);
    }

    // 2. Validate connectionRef ownership (mandatory and fail-closed)
    await this.assertConnectionOwned('Activepieces dispatch', connectionRef, normTenant, normEnv);

    // 3. Require authenticated and HMAC-signed invocation (Fail Closed)
    const apiKey = this.options.activepiecesApiKey || process.env.ACTIVEPIECES_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      throw new Error(
        'Activepieces configuration error: activepiecesApiKey is required for authenticated invocation; failing closed'
      );
    }

    const webhookSecret = this.options.activepiecesWebhookSecret || process.env.ACTIVEPIECES_WEBHOOK_SECRET;
    if (!webhookSecret || !webhookSecret.trim()) {
      throw new Error(
        'Activepieces configuration error: activepiecesWebhookSecret is required for HMAC signing; failing closed'
      );
    }

    // 4. Require explicit Activepieces base URL in production (Fail Closed)
    const rawBaseUrl = (this.options.activepiecesApiUrl || process.env.ACTIVEPIECES_API_URL || '').trim();
    const isProduction =
      normEnv.toLowerCase() === 'production' ||
      (process.env.NODE_ENV || '').toLowerCase() === 'production';

    if (isProduction) {
      if (!rawBaseUrl) {
        throw new Error(
          'Activepieces configuration error: explicit Activepieces base URL (activepiecesApiUrl or ACTIVEPIECES_API_URL) is required in production; failing closed'
        );
      }
    }
    const baseUrl = rawBaseUrl || resolveServiceUrl('ACTIVEPIECES_API_URL', undefined, 'http://localhost:3010');

    // 4. Payload carries connectionRef only - NEVER raw credentials or secrets
    const payload = {
      input,
      context: {
        ...ctx,
        connectionRef: connectionRef ? connectionRef.trim() : undefined,
      },
    };
    const bodyStr = JSON.stringify(payload);

    // 5. Replay protection: timestamp, nonce, and idempotency key
    const timestamp = Date.now().toString();
    const nonce = randomUUID();
    const idempotencyKey = (ctx.idempotencyKey || randomUUID()).trim();

    const signature = createHmac('sha256', webhookSecret.trim())
      .update(`${timestamp}.${nonce}.${bodyStr}`)
      .digest('hex');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
      'X-Activepieces-Signature': signature,
      'X-Activepieces-Timestamp': timestamp,
      'X-Activepieces-Nonce': nonce,
      'X-Idempotency-Key': idempotencyKey,
      'X-Tenant-ID': normTenant,
      'X-Environment-ID': normEnv,
      'X-Workspace-ID': (ctx.workspaceId || '').trim(),
      'X-Correlation-ID': (ctx.correlationId || '').trim(),
    };

    if (connectionRef) {
      headers['X-Connection-Ref'] = connectionRef.trim();
    }

    const res = await fetch(`${baseUrl}/api/v1/webhooks/${normFlow}`, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Activepieces flow error (${res.status}): ${text}`);
    }

    return await res.json().catch(() => ({ status: 'dispatched' }));
  }
}
