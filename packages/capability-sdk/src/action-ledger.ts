import { createHash } from 'node:crypto';
import type { ExecutionContext } from './types';

export interface ActionIdentity { id: string; tenantId: string; environmentId: string; principalId: string; workspaceId: string; toolId: string; inputHash: string }
export type ActionClaim = { status: 'claimed' } | { status: 'succeeded'; output: unknown } | { status: 'running' | 'uncertain' | 'conflict' };
export interface ActionLedger {
  claim(identity: ActionIdentity): Promise<ActionClaim>;
  succeed(identity: ActionIdentity, output: unknown): Promise<void>;
  uncertain(identity: ActionIdentity): Promise<void>;
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function actionIdentity(toolId: string, input: unknown, ctx: ExecutionContext): ActionIdentity {
  if (!ctx.idempotencyKey || !ctx.principalId || !ctx.workspaceId) throw new Error('A write requires a scoped action identity.');
  const inputHash = createHash('sha256').update(stable(input)).digest('hex');
  const id = createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.environmentId, ctx.principalId, ctx.workspaceId, toolId, ctx.actionId ?? `${ctx.idempotencyKey}:${inputHash}`])).digest('hex');
  return { id, tenantId: ctx.tenantId, environmentId: ctx.environmentId, principalId: ctx.principalId, workspaceId: ctx.workspaceId, toolId, inputHash };
}

/** Explicit isolated-test implementation. Production composition supplies durable atomic storage. */
export class MemoryActionLedger implements ActionLedger {
  private readonly rows = new Map<string, { identity: ActionIdentity; status: 'running' | 'succeeded' | 'uncertain'; output?: unknown }>();
  async claim(identity: ActionIdentity): Promise<ActionClaim> {
    const row = this.rows.get(identity.id);
    if (row) {
      if (JSON.stringify(row.identity) !== JSON.stringify(identity)) return { status: 'conflict' };
      return row.status === 'succeeded' ? { status: 'succeeded', output: structuredClone(row.output) } : { status: row.status };
    }
    this.rows.set(identity.id, { identity: { ...identity }, status: 'running' }); return { status: 'claimed' };
  }
  async succeed(identity: ActionIdentity, output: unknown): Promise<void> {
    const row = this.rows.get(identity.id); if (!row || row.status !== 'running') throw new Error('Action claim lost.');
    row.output = structuredClone(output); row.status = 'succeeded';
  }
  async uncertain(identity: ActionIdentity): Promise<void> {
    const row = this.rows.get(identity.id); if (row?.status === 'running') row.status = 'uncertain';
  }
}
