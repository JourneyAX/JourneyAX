import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { journeyaxAuth } from './auth';

import { journeyStartedTrigger } from './triggers/journey-started.trigger';
import { stageChangedTrigger } from './triggers/stage-changed.trigger';
import { orderCommittedTrigger } from './triggers/order-committed.trigger';
import { humanApprovalRequiredTrigger } from './triggers/human-approval-required.trigger';
import { quoteCreatedTrigger } from './triggers/quote-created.trigger';
import { goalCompletedTrigger } from './triggers/goal-completed.trigger';

import { getWorkspaceFactsAction } from './actions/get-workspace-facts.action';
import { appendWorkspaceResultAction } from './actions/append-workspace-result.action';
import { resolveHumanApprovalAction } from './actions/resolve-human-approval.action';
import { reportFailureAction } from './actions/report-failure.action';

export * from './auth';
export * from './crypto';
export * from './triggers/journey-started.trigger';
export * from './triggers/stage-changed.trigger';
export * from './triggers/order-committed.trigger';
export * from './triggers/human-approval-required.trigger';
export * from './triggers/quote-created.trigger';
export * from './triggers/goal-completed.trigger';

export * from './actions/get-workspace-facts.action';
export * from './actions/append-workspace-result.action';
export * from './actions/resolve-human-approval.action';
export * from './actions/report-failure.action';

export const journeyaxPiece = createPiece({
  displayName: 'JourneyAX Operating System',
  auth: journeyaxAuth,
  minimumSupportedRelease: '0.20.0',
  logoUrl: 'https://cdn.journeyax.com/assets/logo.png',
  authors: ['JourneyAX Core Team'],
  actions: [
    getWorkspaceFactsAction,
    appendWorkspaceResultAction,
    resolveHumanApprovalAction,
    reportFailureAction,
  ],
  triggers: [
    journeyStartedTrigger,
    stageChangedTrigger,
    orderCommittedTrigger,
    humanApprovalRequiredTrigger,
    quoteCreatedTrigger,
    goalCompletedTrigger,
  ],
});
