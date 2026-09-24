import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

export interface JourneyStartedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  journeyId: string;
  currentStageId: string;
  timestamp: string;
}

export const journeyStartedTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'journey_started',
  displayName: 'Journey Started',
  description: 'Triggers when a customer enters a new journey workspace in JourneyAX.',
  props: {
    journeyId: Property.ShortText({
      displayName: 'Journey ID (Optional Filter)',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('journey_started', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('journey_started', context);
  },
  async run(context) {
    const payload = context.payload.body as JourneyStartedPayload;
    if (context.propsValue.journeyId && payload.journeyId !== context.propsValue.journeyId) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_sample_started',
    journeyId: 'workwear-solution',
    currentStageId: 'understand_need',
    timestamp: new Date().toISOString(),
  },
});
