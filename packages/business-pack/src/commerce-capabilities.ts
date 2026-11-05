import type { BusinessPackContent } from './schemas/business-pack.schema';
import draftCommerce from './defaults/commerce-capabilities.json';

/** Platform tool contracts, not tenant conversation routes. Selecting a cart/quote tool must publish its actual execution capability. */
export function compileAgentCommerceCapabilities(capabilities: BusinessPackContent['capabilities'], agents: ReadonlyArray<{ allowedTools?: string[] }>, scope: { tenantId: string; environmentId: string }): BusinessPackContent['capabilities'] {
  const compiled: any = structuredClone(capabilities);
  const selected = new Set([...agents.flatMap(agent => agent.allowedTools ?? []), ...compiled.toolDefinitions.map((tool: any) => tool.toolId)]);
  for (const contract of draftCommerce) {
    if (!selected.has('*') && !selected.has('all') && !selected.has(contract.id) && !contract.aliases.some(alias => selected.has(alias))) continue;
    for (const definition of compiled.toolDefinitions) if (definition.toolId === contract.id || contract.aliases.some(alias => alias === definition.toolId)) {
      definition.sideEffect = 'write';
      definition.idempotencyPolicy = { ...(definition.idempotencyPolicy ?? {}), required: true, ttlSeconds: definition.idempotencyPolicy?.ttlSeconds ?? 86400 };
    }
    for (const binding of compiled.toolBindings) if (contract.aliases.some(alias => alias === binding.toolId) && binding.executor?.type === 'native_capability') binding.executor.nativeHandler = contract.id;
    const aliasBinding = compiled.toolBindings.find((binding: any) => contract.aliases.some(alias => alias === binding.toolId));
    const aliasDefinition = compiled.toolDefinitions.find((tool: any) => contract.aliases.some(alias => alias === tool.toolId));
    if (!compiled.toolDefinitions.some((tool: any) => tool.toolId === contract.id)) compiled.toolDefinitions.push({
      ...(aliasDefinition ?? {}), toolId: contract.id, version: '1.0.0', displayName: contract.name,
      description: 'Owner-scoped, reversible draft changes. Catalogue prices and merchant policy remain authoritative.',
      inputSchema: {}, outputSchema: {}, sideEffect: 'write', risk: aliasDefinition?.risk ?? 'low',
      timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 }, idempotencyPolicy: { required: true, ttlSeconds: 86400 }, approvalPolicy: { requiresApproval: false, ttlMinutes: 60 }, dataClassification: 'internal',
    });
    if (!compiled.toolBindings.some((binding: any) => binding.toolId === contract.id)) compiled.toolBindings.push({
      ...(aliasBinding ?? {}), toolId: contract.id, agentTool: contract.agentTool, tenantId: scope.tenantId, environmentId: scope.environmentId, bindingVersion: '1.0.0', enabled: aliasBinding?.enabled ?? true,
      executor: aliasBinding?.executor?.type && aliasBinding.executor.type !== 'native_capability' ? aliasBinding.executor : { type: 'native_capability', nativeHandler: contract.id },
      policy: { requiredRole: 'customer', requiresConfirmation: false, timeoutMs: 10000, retryAttempts: 0, ...(aliasBinding?.policy ?? {}), idempotencyRequired: true },
    });
  }
  if (selected.has('get_checkout_receipt')) {
    if (!compiled.toolDefinitions.some((tool: any) => tool.toolId === 'checkout.receipt')) compiled.toolDefinitions.push({ toolId: 'checkout.receipt', version: '1.0.0', displayName: 'Read owned checkout receipt', description: 'Read the authenticated customer’s committed checkout receipt. Does not assert live fulfilment or inventory.', inputSchema: {}, outputSchema: {}, sideEffect: 'read', risk: 'low', timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 }, idempotencyPolicy: { required: false, ttlSeconds: 86400 }, approvalPolicy: { requiresApproval: false, ttlMinutes: 60 }, dataClassification: 'internal' });
    if (!compiled.toolBindings.some((binding: any) => binding.toolId === 'checkout.receipt')) compiled.toolBindings.push({ toolId: 'checkout.receipt', agentTool: 'get_checkout_receipt', tenantId: scope.tenantId, environmentId: scope.environmentId, bindingVersion: '1.0.0', enabled: true, executor: { type: 'native_capability', nativeHandler: 'checkout.receipt' }, policy: { requiredRole: 'customer', requiresConfirmation: false, timeoutMs: 10000, retryAttempts: 0, idempotencyRequired: false } });
  }
  return compiled;
}
