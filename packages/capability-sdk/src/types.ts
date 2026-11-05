import { ToolDefinition, ToolBinding, StageBinding, AgentDefinition } from '@journeyax/business-pack';

export { ToolDefinition, ToolBinding, StageBinding, AgentDefinition };

export interface ExecutionContext {
  /** Server-issued signed connector scope, never supplied by a model. */
  callerScope?: string;
  tenantId: string;
  environmentId: 'dev' | 'test' | 'staging' | 'production';
  workspaceId: string;
  sessionId: string;
  principalId?: string;
  principalRole?: string;
  stageId: string;
  packVersionId: string;
  correlationId: string;
  idempotencyKey?: string;
  /** Server-owned business action/confirmation slot. Never supplied by the model. */
  actionId?: string;
  /** Pack-declared, checksum-bound settings handed to native handlers (e.g. the tenant catalog mapping). */
  packSettings?: { catalogMapping?: unknown; [key: string]: any };
  vocabulary?: any;
  glossary?: any;
  release?: any;
  okfRelease?: any;
  [key: string]: any;
}

export interface ExecutionRequest<TInput = any> {
  toolId: string;
  input: TInput;
  idempotencyKey?: string;
  userConfirmationConfirmed?: boolean;
  /**
   * The connector policy state the access layer worked out for this person and tool (`allow`, `ask` first, `blocked`). Set by server code
   * only, never from model output. When present it decides the call: the legacy role and side-effect checks are replaced by it.
   */
  policyState?: 'allow' | 'ask' | 'blocked';
}

export type ExecutionStatus = 'success' | 'failure' | 'requires_approval' | 'denied';

export interface ExecutionResponse<TOutput = any> {
  toolId: string;
  status: ExecutionStatus;
  output?: TOutput;
  error?: string;
  durationMs: number;
  idempotentReplay?: boolean;
  approvalRequestId?: string;
  provenance: {
    executorType: string;
    executedAt: string;
    correlationId: string;
  };
}

export interface PolicyCheckResult {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
}

export interface NativeCapabilityHandler<TInput = any, TOutput = any> {
  /** Platform-owned declaration: scoped draft state only, never payment, fulfilment or an external system. */
  readonly reversibleDraft?: boolean;
  execute(input: TInput, ctx: ExecutionContext): Promise<TOutput>;
}
