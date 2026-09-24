import { ToolDefinition, ToolBinding, StageBinding, AgentDefinition } from '@journeyax/business-pack';

export { ToolDefinition, ToolBinding, StageBinding, AgentDefinition };

export interface ExecutionContext {
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
}

export interface ExecutionRequest<TInput = any> {
  toolId: string;
  input: TInput;
  idempotencyKey?: string;
  userConfirmationConfirmed?: boolean;
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
  execute(input: TInput, ctx: ExecutionContext): Promise<TOutput>;
}
