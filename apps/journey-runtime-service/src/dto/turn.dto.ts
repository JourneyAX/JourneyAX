import { z } from 'zod';

export const TurnCommandRequestSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  workspaceId: z.string().optional(),
  turnId: z.string().min(1, 'turnId is required'),
  correlationId: z.string().min(1, 'correlationId is required'),
  message: z.string().max(10000).optional(),
  event: z
    .object({
      type: z.string(),
      payload: z.any(),
    })
    .optional(),
  inputFacts: z.record(z.string(), z.any()).optional(),
  approvalRequestId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  tenantId: z.string().optional(),
  environmentId: z.enum(['dev', 'test', 'staging', 'production']).optional(),
  environment: z.string().optional(),
  projectId: z.string().optional(),
  journeyId: z.string().optional(),
});

export type TurnCommandRequest = z.infer<typeof TurnCommandRequestSchema>;

export const DecideApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional(),
});

export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;

export const AppendFactRequestSchema = z.object({
  key: z.string().min(1, 'key is required').max(200),
  value: z.any(),
  source: z.enum(['customer', 'system', 'inference', 'tool', 'external']).optional(),
});

export type AppendFactRequest = z.infer<typeof AppendFactRequestSchema>;

export const ActivepiecesWebhookSchema = z.object({
  event: z.string().min(1),
  tenantId: z.string().optional(),
  environmentId: z.string().optional(),
  workspaceId: z.string().optional(),
  data: z.record(z.string(), z.any()),
});

export type ActivepiecesWebhookRequest = z.infer<typeof ActivepiecesWebhookSchema>;

export const RegisterWebhookSubscriptionSchema = z.object({
  event: z.string().min(1, 'event is required'),
  webhookUrl: z.string().url('webhookUrl must be a valid URL'),
});

export type RegisterWebhookSubscriptionRequest = z.infer<typeof RegisterWebhookSubscriptionSchema>;
