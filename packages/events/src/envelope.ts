import { randomUUID } from 'crypto';

export type StandardEventType =
  | 'journey.started'
  | 'journey.stage.changed'
  | 'journey.handoff.requested'
  | 'quote.created'
  | 'order.paid'
  | 'evaluation.failed'
  | 'ingestion.completed'
  | 'capability.executed'
  | 'approval.requested'
  | 'approval.completed'
  | string;

export interface EventEnvelope<TData = any> {
  eventId: string;
  eventType: StandardEventType;
  tenantId: string;
  workspaceId: string;
  journeyId: string;
  packVersionId: string;
  correlationId: string;
  occurredAt: string;
  data: TData;
}

export function createEventEnvelope<TData = any>(params: {
  eventType: StandardEventType;
  tenantId: string;
  workspaceId: string;
  journeyId: string;
  packVersionId: string;
  correlationId?: string;
  data: TData;
}): EventEnvelope<TData> {
  return {
    eventId: `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    eventType: params.eventType,
    tenantId: params.tenantId,
    workspaceId: params.workspaceId,
    journeyId: params.journeyId,
    packVersionId: params.packVersionId,
    correlationId: params.correlationId || `corr_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    occurredAt: new Date().toISOString(),
    data: params.data,
  };
}
