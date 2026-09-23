import { z } from 'zod';

export const ToolDefinitionSchema = z.object({
  toolId: z.string(),
  version: z.string().default('1.0.0'),
  displayName: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.any()).default({}),
  outputSchema: z.record(z.string(), z.any()).default({}),
  sideEffect: z.enum(['read', 'write', 'transactional']).default('read'),
  risk: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
});

export const ExecutorSchema = z.object({
  type: z.enum(['native_capability', 'activepieces_flow', 'approved_openapi', 'mcp_tool', 'specialist_agent']),
  nativeHandler: z.string().optional(),
  flowId: z.string().optional(),
  connectionRef: z.string().optional(),
  openApiOpId: z.string().optional(),
  mcpServerName: z.string().optional(),
  agentId: z.string().optional(),
});

export const ToolPolicySchema = z.object({
  requiredRole: z.string().default('customer'),
  requiresConfirmation: z.boolean().default(false),
  idempotencyRequired: z.boolean().default(false),
  timeoutMs: z.number().int().default(10000),
  retryAttempts: z.number().int().default(0),
});

export const ToolBindingSchema = z.object({
  tenantId: z.string(),
  environmentId: z.enum(['dev', 'test', 'staging', 'production']),
  toolId: z.string(),
  bindingVersion: z.string().default('1.0.0'),
  executor: ExecutorSchema,
  policy: ToolPolicySchema.default({
    requiredRole: 'customer',
    requiresConfirmation: false,
    idempotencyRequired: false,
    timeoutMs: 10000,
    retryAttempts: 0,
  }),
});

export const StageToolBindingSchema = z.object({
  toolId: z.string(),
  condition: z.object({
    factsPresent: z.array(z.string()).optional(),
    ruleExpression: z.string().optional(),
  }).optional(),
});

export const StageBindingSchema = z.object({
  journeyId: z.string(),
  stageId: z.string(),
  tools: z.array(StageToolBindingSchema),
});

export const CapabilityBindingsCollectionSchema = z.object({
  version: z.string().default('1.0.0'),
  toolDefinitions: z.array(ToolDefinitionSchema).default([]),
  toolBindings: z.array(ToolBindingSchema).default([]),
  stageBindings: z.array(StageBindingSchema).default([]),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolBinding = z.infer<typeof ToolBindingSchema>;
export type StageBinding = z.infer<typeof StageBindingSchema>;
export type CapabilityBindingsCollection = z.infer<typeof CapabilityBindingsCollectionSchema>;
