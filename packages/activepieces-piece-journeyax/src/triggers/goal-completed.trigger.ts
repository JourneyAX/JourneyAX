import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

export interface GoalCompletedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  journeyId: string;
  goalId: string;
  completedAt: string;
  summary: string;
  finalFacts: Record<string, any>;
}

export const goalCompletedTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'goal_completed',
  displayName: 'Goal Completed',
  description: 'Triggers when a customer workspace completes target journey milestones.',
  props: {
    journeyId: Property.ShortText({
      displayName: 'Journey ID (Optional Filter)',
      description: 'Filter events for a specific Journey definition ID',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('goal_completed', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('goal_completed', context);
  },
  async run(context) {
    const payload = context.payload.body as GoalCompletedPayload;
    if (context.propsValue.journeyId && payload.journeyId !== context.propsValue.journeyId) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_sample_123',
    journeyId: 'workwear-solution',
    goalId: 'purchase_complete',
    completedAt: new Date().toISOString(),
    summary: 'Journey goal achieved.',
    finalFacts: {
      totalCents: 20495,
      currency: 'AUD',
    },
  },
});
