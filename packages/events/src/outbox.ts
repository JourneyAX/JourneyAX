import { EventEnvelope } from './envelope';
import { randomUUID } from 'crypto';

export type OutboxStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead_letter';

export interface OutboxEvent {
  outboxId: string;
  envelope: EventEnvelope;
  destination: 'activepieces' | 'webhook' | 'audit_log';
  targetUrl?: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastAttemptAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createOutboxEvent(params: {
  envelope: EventEnvelope;
  destination?: 'activepieces' | 'webhook' | 'audit_log';
  targetUrl?: string;
  maxAttempts?: number;
}): OutboxEvent {
  const now = new Date();
  return {
    outboxId: `obx_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    envelope: params.envelope,
    destination: params.destination || 'activepieces',
    targetUrl: params.targetUrl,
    status: 'pending',
    attempts: 0,
    maxAttempts: params.maxAttempts || 5,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
