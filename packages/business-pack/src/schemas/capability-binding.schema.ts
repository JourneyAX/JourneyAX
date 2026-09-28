import { z } from 'zod';

export const TimeoutPolicySchema = z.object({
  timeoutMs: z.number().int().default(10000),
  retryAttempts: z.number().int().default(0),
}).default({
  timeoutMs: 10000,
  retryAttempts: 0,
});

export const IdempotencyPolicySchema = z.object({
  required: z.boolean().default(false),
  keyExtractionPath: z.string().optional(),
  ttlSeconds: z.number().int().default(86400),
}).default({
  required: false,
  ttlSeconds: 86400,
});

export const ApprovalPolicySchema = z.object({
  requiresApproval: z.boolean().default(false),
  approvalRole: z.string().optional(),
  ttlMinutes: z.number().int().default(60),
}).default({
  requiresApproval: false,
  ttlMinutes: 60,
});

export const ToolDefinitionSchema = z.object({
  toolId: z.string(),
  version: z.string().default('1.0.0'),
  displayName: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.any()).default({}),
  outputSchema: z.record(z.string(), z.any()).default({}),
  inputMapping: z.record(z.string(), z.string()).optional(),
  outputFactMapping: z.record(z.string(), z.string()).optional(),
  sideEffect: z.enum(['read', 'write', 'transactional']).default('read'),
  risk: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
  timeoutPolicy: TimeoutPolicySchema,
  idempotencyPolicy: IdempotencyPolicySchema,
  approvalPolicy: ApprovalPolicySchema,
  dataClassification: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
});

export const SUPPORTED_SECRET_SCHEMES = [
  'gcp-secret://',
  'vault://',
  'aws-sm://',
  'aws-secretsmanager://',
  'tenant-secret://',
] as const;

export const RAW_SECRET_PATTERN =
  /^(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_\-]{35}|bearer\s+[a-zA-Z0-9_\-\.]+|[a-f0-9]{32,64})/i;

export const CANONICAL_SECRET_ENVIRONMENTS = ['dev', 'test', 'staging', 'production'] as const;

export interface ParsedSecretRef {
  raw: string;
  scheme: string;
  scope?: string;
  tenantId: string;
  environmentId: string;
  secretKey: string;
}

export interface SecretRefIssue {
  code:
    | 'RAW_SECRET'
    | 'INVALID_SCHEME'
    | 'INVALID_STRUCTURE'
    | 'INVALID_ENVIRONMENT'
    | 'CROSS_TENANT'
    | 'CROSS_ENVIRONMENT';
  message: string;
}

export function parseCanonicalSecretRef(secretRef: string): {
  parsed?: ParsedSecretRef;
  issues: SecretRefIssue[];
} {
  const issues: SecretRefIssue[] = [];
  if (!secretRef || typeof secretRef !== 'string') {
    issues.push({
      code: 'INVALID_STRUCTURE',
      message: 'secretRef must be a non-empty string URI reference',
    });
    return { issues };
  }

  const trimmed = secretRef.trim();
  if (RAW_SECRET_PATTERN.test(trimmed)) {
    issues.push({
      code: 'RAW_SECRET',
      message: `secretRef contains a raw secret token or key instead of a tenant-scoped URI reference: '${trimmed.substring(0, 10)}...'`,
    });
    return { issues };
  }

  const matchedScheme = SUPPORTED_SECRET_SCHEMES.find((s) => trimmed.startsWith(s));
  if (!matchedScheme) {
    issues.push({
      code: 'INVALID_SCHEME',
      message: `secretRef '${secretRef}' uses unsupported scheme. Must start with a valid URI scheme (${SUPPORTED_SECRET_SCHEMES.join(', ')}).`,
    });
    return { issues };
  }

  const pathPart = trimmed.substring(matchedScheme.length);
  const segments = pathPart.split('/').filter(Boolean);

  if (segments.length < 3) {
    issues.push({
      code: 'INVALID_STRUCTURE',
      message: `secretRef '${secretRef}' has invalid structure. Must explicitly carry <tenantId>/<environmentId>/<secretKey> namespace segments (<scheme>://[scope/]<tenantId>/<environmentId>/<secretKey>).`,
    });
    return { issues };
  }

  const secretKey = segments[segments.length - 1];
  const environmentId = segments[segments.length - 2];
  const tenantId = segments[segments.length - 3];
  const scope = segments.length > 3 ? segments.slice(0, segments.length - 3).join('/') : undefined;

  if (!CANONICAL_SECRET_ENVIRONMENTS.includes(environmentId as any)) {
    issues.push({
      code: 'INVALID_ENVIRONMENT',
      message: `secretRef '${secretRef}' specifies invalid environment '${environmentId}'. Must be one of: ${CANONICAL_SECRET_ENVIRONMENTS.join(', ')}.`,
    });
  }

  const parsed: ParsedSecretRef = {
    raw: secretRef,
    scheme: matchedScheme,
    scope,
    tenantId,
    environmentId,
    secretKey,
  };

  return { parsed, issues };
}

export function validateSecretReference(
  secretRef: string,
  expectedTenantId?: string,
  expectedEnvironmentId?: string
): SecretRefIssue[] {
  const { parsed, issues } = parseCanonicalSecretRef(secretRef);
  if (!parsed) {
    return issues;
  }

  if (expectedTenantId && parsed.tenantId !== expectedTenantId) {
    issues.push({
      code: 'CROSS_TENANT',
      message: `Cross-tenant secretRef violation: secretRef '${secretRef}' references tenant '${parsed.tenantId}' but binding belongs to '${expectedTenantId}'`,
    });
  }

  if (expectedEnvironmentId && parsed.environmentId !== expectedEnvironmentId) {
    issues.push({
      code: 'CROSS_ENVIRONMENT',
      message: `Cross-environment secretRef violation: secretRef '${secretRef}' references environment '${parsed.environmentId}' but binding belongs to '${expectedEnvironmentId}'`,
    });
  }

  return issues;
}

export const SecretRefSchema = z.string().superRefine((ref, ctx) => {
  const { issues } = parseCanonicalSecretRef(ref);
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
    });
  }
});

export const ExecutorSchema = z.object({
  type: z.enum(['native_capability', 'activepieces_flow', 'approved_openapi', 'mcp_tool', 'specialist_agent']),
  nativeHandler: z.string().optional(),
  flowId: z.string().optional(),
  connectionRef: z.string().optional(),
  secretRef: SecretRefSchema.optional(),
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

export const ToolBindingSchema = z
  .object({
    tenantId: z.string(),
    environmentId: z.enum(['dev', 'test', 'staging', 'production']),
    toolId: z.string(),
    bindingVersion: z.string().default('1.0.0'),
    executor: ExecutorSchema,
    enabled: z.boolean().default(true),
    inputMapping: z.record(z.string(), z.string()).optional(),
    outputFactMapping: z.record(z.string(), z.string()).optional(),
    policyOverrides: z.record(z.string(), z.any()).optional(),
    policy: ToolPolicySchema.default({
      requiredRole: 'customer',
      requiresConfirmation: false,
      idempotencyRequired: false,
      timeoutMs: 10000,
      retryAttempts: 0,
    }),
  })
  .superRefine((binding, ctx) => {
    const secretRef = binding.executor?.secretRef;
    if (!secretRef) return;

    const issues = validateSecretReference(secretRef, binding.tenantId, binding.environmentId);
    for (const issue of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executor', 'secretRef'],
        message: issue.message,
      });
    }
  });

export const StageToolBindingSchema = z.object({
  toolId: z.string(),
  inputMapping: z.record(z.string(), z.string()).optional(),
  outputFactMapping: z.record(z.string(), z.string()).optional(),
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
