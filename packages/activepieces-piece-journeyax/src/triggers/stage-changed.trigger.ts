import { createTrigger, TriggerStrategy, Property } from '@activepieces/pieces-framework';
import { journeyaxAuth } from '../auth';
import { registerWebhookTrigger, unregisterWebhookTrigger } from '../webhook-lifecycle';

export interface StageChangedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  journeyId: string;
  fromStageId: string;
  toStageId: string;
  reason: string;
  facts: Record<string, any>;
  timestamp: string;
}

export const stageChangedTrigger = createTrigger({
  auth: journeyaxAuth,
  name: 'stage_changed',
  displayName: 'Stage Changed',
  description: 'Triggers when a customer workspace transitions from one journey stage to another.',
  props: {
    journeyId: Property.ShortText({
      displayName: 'Journey ID (Optional Filter)',
      required: false,
    }),
    toStageId: Property.ShortText({
      displayName: 'Target Stage ID (Optional Filter)',
      required: false,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  async onEnable(context) {
    await registerWebhookTrigger('stage_changed', context);
  },
  async onDisable(context) {
    await unregisterWebhookTrigger('stage_changed', context);
  },
  async run(context) {
    const payload = context.payload.body as StageChangedPayload;
    if (context.propsValue.journeyId && payload.journeyId !== context.propsValue.journeyId) {
      return [];
    }
    if (context.propsValue.toStageId && payload.toStageId !== context.propsValue.toStageId) {
      return [];
    }
    return [payload];
  },
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_sample_stage',
    journeyId: 'workwear-solution',
    fromStageId: 'understand_need',
    toStageId: 'build_solution',
    reason: 'Required facts satisfied',
    facts: {},
    timestamp: new Date().toISOString(),
  },
});
