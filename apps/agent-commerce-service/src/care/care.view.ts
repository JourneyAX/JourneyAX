import type { CareCase, CareTicketView } from './care.types';

/** The case as the portal draws it: minutes to the promised time, and nothing the server alone should hold (the actions behind each step). */
export function toView(doc: CareCase, nowMs: number): CareTicketView {
  const { tenantId, requester, zendeskId, zendeskUpdatedAt, createdAt, updatedAt, dueAt, steps, draft, approval, claimedAt, trace, raw, ...rest } = doc;
  void tenantId; void requester; void zendeskId; void zendeskUpdatedAt; void createdAt; void updatedAt; void claimedAt; void trace; void raw;
  return {
    ...rest,
    desk: rest.desk ?? 'care',
    slaMinutes: Math.round((Date.parse(dueAt) - nowMs) / 60_000),
    steps: steps.map(({ action, ...step }) => { void action; return step; }),
    draft: { isReply: draft.isReply, text: draft.text },
    ...(approval ? { approval: { by: approval.by, at: approval.at, edited: approval.edited, removedSteps: approval.removedSteps, corrections: approval.corrections, results: approval.results } } : {}),
  };
}
