import { createHash } from 'crypto';

export interface IdempotencyRecord {
  tenantId: string;
  idempotencyKey: string;
  capabilityRunId: string;
  toolId: string;
  status: 'pending' | 'completed' | 'failed';
  resultHash?: string;
  response?: any;
  createdAt: Date;
  expiresAt: Date;
}

export function computePayloadHash(payload: any): string {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return createHash('sha256').update(json).digest('hex');
}
