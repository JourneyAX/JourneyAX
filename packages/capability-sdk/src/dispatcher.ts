import {
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
  ExecutionRequest,
  ExecutionResponse,
  NativeCapabilityHandler,
} from './types';
import { PolicyGate } from './policy-gate';

export interface DispatcherOptions {
  activepiecesApiUrl?: string;
  activepiecesApiKey?: string;
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
          const handler = this.nativeHandlers.get(handlerKey);
          if (!handler) {
            throw new Error(`No native capability handler registered for '${handlerKey}'`);
          }
          output = await handler.execute(request.input, effectiveCtx);
          break;
        }

        case 'activepieces_flow': {
          // Dispatches to external Activepieces flow
          output = await this.invokeActivepiecesFlow(executor.flowId!, request.input, effectiveCtx);
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

  private async invokeActivepiecesFlow(flowId: string, input: any, ctx: ExecutionContext): Promise<any> {
    const baseUrl = this.options.activepiecesApiUrl || process.env.ACTIVEPIECES_API_URL || 'http://localhost:3010';
    const res = await fetch(`${baseUrl}/api/v1/webhooks/${flowId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': ctx.tenantId,
        'X-Workspace-ID': ctx.workspaceId,
        'X-Correlation-ID': ctx.correlationId,
      },
      body: JSON.stringify({ input, context: ctx }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Activepieces flow error (${res.status}): ${text}`);
    }

    return await res.json().catch(() => ({ status: 'dispatched' }));
  }
}
