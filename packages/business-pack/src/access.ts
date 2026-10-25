/**
 * Which agents a person may use, from who they are and the pack's access table.
 *
 * Pure and small on purpose: the router, the tool executor, the publication gate and the "view as" preview all ask this one function,
 * so they cannot disagree. See `schemas/access.schema.ts` for the rules of the table.
 */
import type { Principal } from '@journeyax/shared-types';
import { AGENT_ACCESS_LEVELS, type AgentAccess, type AgentAccessLevel, type AgentAccessRow } from './schemas/access.schema';

export interface EffectiveAgent {
  agentId: string;
  /** `available`, `default` or `required`; an agent the person may not use is not listed. */
  level: Exclude<AgentAccessLevel, 'not_available'>;
  /** `open` when the agent has no rows (everyone may use it), `row` when a row grants it. */
  via: 'open' | 'row';
}

export interface EffectiveAccess {
  /** The agents this person may use, in the pack's order. */
  agents: EffectiveAgent[];
  /** The agent that opens by default for this person, when a row says so; otherwise the pack's own default applies. */
  defaultAgentId?: string;
  /** Set when a `required` row applies: the only agent this person may use. */
  lockedAgentId?: string;
}

const RANK: Record<AgentAccessLevel, number> = Object.fromEntries(AGENT_ACCESS_LEVELS.map((level, index) => [level, index])) as Record<AgentAccessLevel, number>;

/** Does this row apply to this person? Shopper rows apply to everyone; staff rows only to staff, and only to the groups they name (none named: all staff). */
export function rowApplies(row: AgentAccessRow, principal: Pick<Principal, 'audience' | 'groups'>): boolean {
  if (row.audience === 'shopper') return true;
  if (principal.audience !== 'staff') return false;
  return row.groups.length === 0 || row.groups.some((group) => principal.groups.includes(group));
}

export function resolveAccess(agents: Array<{ agentId: string }>, access: AgentAccess | undefined, principal: Pick<Principal, 'audience' | 'groups'>): EffectiveAccess {
  const rowsByAgent = new Map<string, AgentAccessRow[]>();
  for (const row of access?.rows ?? []) {
    const list = rowsByAgent.get(row.agentId);
    if (list) list.push(row); else rowsByAgent.set(row.agentId, [row]);
  }

  const effective: EffectiveAgent[] = [];
  /** Agents whose best level comes from a row written for staff: for a member of staff these win the choice of default over a shopper's default. */
  const staffSpecific = new Set<string>();
  for (const { agentId } of agents) {
    const rows = rowsByAgent.get(agentId);
    if (!rows) {
      effective.push({ agentId, level: 'available', via: 'open' });
      continue;
    }
    const applicable = rows.filter((row) => rowApplies(row, principal));
    if (applicable.length === 0) continue;
    const best = applicable.reduce((top, row) => (RANK[row.level] > RANK[top] ? row.level : top), 'not_available' as AgentAccessLevel);
    if (best === 'not_available') continue;
    effective.push({ agentId, level: best, via: 'row' });
    if (applicable.some((row) => row.audience === 'staff' && row.level === best)) staffSpecific.add(agentId);
  }

  const locked = effective.find((agent) => agent.level === 'required');
  if (locked) return { agents: [locked], defaultAgentId: locked.agentId, lockedAgentId: locked.agentId };
  const defaults = effective.filter((agent) => agent.level === 'default');
  const preferred = (principal.audience === 'staff' ? defaults.find((agent) => staffSpecific.has(agent.agentId)) : undefined) ?? defaults[0];
  return { agents: effective, ...(preferred ? { defaultAgentId: preferred.agentId } : {}) };
}

/** Can an anonymous shopper reach this agent? Used by the publication gate: a pack must leave shoppers at least one agent. */
export function shopperCanUse(agentId: string, access: AgentAccess | undefined): boolean {
  return resolveAccess([{ agentId }], access, { audience: 'shopper', groups: [] }).agents.length > 0;
}
