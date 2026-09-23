import { ToolDefinition, ToolBinding, ExecutionContext, ExecutionRequest, PolicyCheckResult } from './types';

export class PolicyGate {
  /**
   * Enforces security, approval, and idempotency checks before tool execution.
   */
  checkPolicy(
    tool: ToolDefinition,
    binding: ToolBinding,
    request: ExecutionRequest,
    ctx: ExecutionContext
  ): PolicyCheckResult {
    const policy = binding.policy;

    // 1. Role / Permission Check
    if (policy.requiredRole && policy.requiredRole !== 'customer') {
      const userRole = ctx.principalRole || 'customer';
      if (!this.roleSatisfies(userRole, policy.requiredRole)) {
        return {
          allowed: false,
          reason: `Action requires role '${policy.requiredRole}', but current role is '${userRole}'.`,
        };
      }
    }

    // 2. Idempotency Requirement Check
    if (policy.idempotencyRequired && !request.idempotencyKey) {
      return {
        allowed: false,
        reason: `Tool '${tool.toolId}' requires an idempotencyKey for safe execution.`,
      };
    }

    // 3. Human Confirmation / Approval Check
    if (
      (policy.requiresConfirmation || tool.sideEffect === 'write' || tool.risk === 'high' || tool.risk === 'critical') &&
      !request.userConfirmationConfirmed
    ) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `Tool '${tool.toolId}' performs side-effects (${tool.sideEffect}) and requires explicit user confirmation before execution.`,
      };
    }

    return { allowed: true };
  }

  private roleSatisfies(userRole: string, requiredRole: string): boolean {
    if (userRole === 'admin') return true;
    if (userRole === 'csr' && requiredRole === 'customer') return true;
    return userRole === requiredRole;
  }
}
