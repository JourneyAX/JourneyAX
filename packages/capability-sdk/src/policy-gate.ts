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
    const policy = binding.policy || (tool as any)?.policy || {};
    const state = request.policyState;

    // 0. An explicit connector policy state (allow / ask first / blocked) was worked out for this person by the access layer.
    if (state === 'blocked') {
      return { allowed: false, reason: `Tool '${tool.toolId}' is blocked for you.` };
    }

    // 1. Role / Permission Check (replaced by the group rules when a policy state was given)
    if (policy.requiredRole && !state) {
      const userRole = ctx.principalRole || 'customer';
      if (!this.roleSatisfies(userRole, policy.requiredRole)) {
        return {
          allowed: false,
          reason: `Action requires role '${policy.requiredRole}', but current role is '${userRole}'.`,
        };
      }
    }

    // 2. Idempotency Requirement Check
    const effectiveIdempotencyKey = request.idempotencyKey || ctx.idempotencyKey;
    if (policy.idempotencyRequired && !effectiveIdempotencyKey) {
      return {
        allowed: false,
        reason: `Tool '${tool.toolId}' requires an idempotencyKey for safe execution.`,
      };
    }

    // 2b. The administrator's explicit choice decides whether a person must confirm; the side-effect heuristics below do not apply.
    if (state === 'ask') {
      if (!request.userConfirmationConfirmed) {
        return {
          allowed: false,
          requiresApproval: true,
          reason: `Tool '${tool.toolId}' asks first: a person must approve this exact call before it runs.`,
        };
      }
      return { allowed: true };
    }
    if (state === 'allow') {
      return { allowed: true };
    }

    // 3. Human Confirmation / Approval Check
    const riskRequiresApproval = tool.risk === 'medium' || tool.risk === 'high' || tool.risk === 'critical';
    const hasSideEffect = tool.sideEffect === 'write' || tool.sideEffect === 'transactional';
    if (
      (policy.requiresConfirmation || hasSideEffect || riskRequiresApproval) &&
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
