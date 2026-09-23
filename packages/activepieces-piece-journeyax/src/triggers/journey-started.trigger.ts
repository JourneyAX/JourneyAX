export interface JourneyStartedPayload {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  journeyId: string;
  currentStageId: string;
  timestamp: string;
}

export const journeyStartedTrigger = {
  name: 'journey_started',
  displayName: 'Journey Started',
  description: 'Triggers when a customer enters a new journey workspace in JourneyAX.',
  sampleData: {
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: 'ws_wwg_apprentice_1727136000000',
    journeyId: 'workwear-solution',
    currentStageId: 'understand_need',
    timestamp: '2026-09-23T22:00:00.000Z',
  },
};
