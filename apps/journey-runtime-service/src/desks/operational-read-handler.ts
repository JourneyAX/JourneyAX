import type { ExecutionContext, NativeCapabilityHandler } from '@journeyax/capability-sdk';
import { principalFrom } from '@journeyax/shared-types';
import { executeIqTool, isIqTool } from '../agent/iq-tools';
import { deskSummaries, readOperationalDesk, deskToolResult } from './operational-desks';
import type { AgentToolContext } from '../agent/agent-tools';

/** Capability bindings and agent tools share one read implementation and the same verified execution identity. */
export class OperationalReadHandler implements NativeCapabilityHandler {
  constructor(private readonly name: string) {}
  async execute(input: Record<string, unknown>, execution: ExecutionContext) {
    const principal = principalFrom({ userId: execution.principalId, tenantId: execution.tenantId, role: execution.principalRole, groups: execution.principalGroups });
    const context = { ...execution, release: execution.release, principal: { audience: principal.audience, groups: principal.groups }, companies: execution.companies ?? [], readSourceIds: new Set<string>() } as unknown as AgentToolContext;
    if (isIqTool(this.name)) return executeIqTool(this.name, input, context);
    if (this.name === 'list_desks') return { desks: deskSummaries(context) };
    if (this.name === 'read_desk') return deskToolResult(await readOperationalDesk(String(input.deskId ?? ''), input.recordId as string | undefined, context, undefined, input.cursor as string | undefined));
    throw new Error('Unknown operational read capability.');
  }
}
