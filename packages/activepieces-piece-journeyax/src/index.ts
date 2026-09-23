export * from './triggers/journey-started.trigger';
export * from './triggers/stage-changed.trigger';
export * from './triggers/order-committed.trigger';
export * from './triggers/human-approval-required.trigger';
export * from './actions/get-workspace-facts.action';
export * from './actions/append-workspace-result.action';
export * from './actions/resolve-human-approval.action';

export const journeyaxPiece = {
  name: '@journeyax/activepieces-piece',
  displayName: 'JourneyAX Operating System',
  description: 'Triggers and actions connecting JourneyAX agentic customer workspaces with external automations.',
  triggers: [
    'journey_started',
    'stage_changed',
    'order_committed',
    'human_approval_required',
  ],
  actions: [
    'get_workspace_facts',
    'append_workspace_result',
    'resolve_human_approval',
  ],
};
