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

export const stageChangedTrigger = {
  name: 'stage_changed',
  displayName: 'Stage Changed',
  description: 'Triggers when a customer workspace transitions from one journey stage to another.',
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_wwg_apprentice_1727136000000',
    journeyId: 'workwear-solution',
    fromStageId: 'understand_need',
    toStageId: 'build_solution',
    reason: 'Required facts satisfied (trade, budget)',
    facts: {
      occupation: 'apprentice electrician',
      budget: { amountCents: 25000, currency: 'AUD' },
    },
    timestamp: '2026-09-23T22:00:00.000Z',
  },
};
