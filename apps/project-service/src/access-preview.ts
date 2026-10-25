/**
 * "View as": which agents a person of a given kind would get, from the project's current settings.
 *
 * Read-only and computed by the same function the runtime uses (`resolveAccess`), so the preview cannot disagree with what a person would
 * really get. It reads the project's settings (what a publish would send live), not the published pack, so an admin can check a table
 * before publishing it. The stage-by-stage routing of the journey is not previewed: only who may use which agent, and which opens first.
 */
import { resolveAccess, AgentAccessSchema } from '@journeyax/business-pack';
import { normaliseGroupId, normaliseGroups, type Audience } from '@journeyax/shared-types';

export interface AccessPreviewInput {
  audience: Audience;
  groups: string[];
}

export interface AccessPreviewAgent {
  agentId: string;
  name: string;
  level: 'available' | 'default' | 'required';
  via: 'open' | 'row';
  /** True for the agent that opens first for this person (a locked agent, the table's default, or the pack's own default if they may use it). */
  opensFirst: boolean;
}

export interface AccessPreview {
  audience: Audience;
  groups: string[];
  agents: AccessPreviewAgent[];
  lockedAgentId?: string;
  /** Groups the table names, or the preview asked about, that match no team of the project. Shown so a typo does not pass quietly. */
  unknownGroups: string[];
  /** Groups the project's teams provide, as ids a table row can use. */
  knownGroups: string[];
  /** True when the project has an access table at all; without it every agent is open to everyone. */
  hasTable: boolean;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export function buildAccessPreview(
  project: { agents?: any[]; extensions?: any; defaultAgentId?: string; routingPolicy?: { defaultAgentId?: string } } | null | undefined,
  teams: Array<{ teamId?: string; name?: string }>,
  input: AccessPreviewInput,
): AccessPreview {
  const agents = (Array.isArray(project?.agents) ? project!.agents! : []).filter((a) => a && asString(a.agentId));
  const parsed = AgentAccessSchema.safeParse(project?.extensions?.agentAccess);
  const table = parsed.success ? parsed.data : undefined;
  const groups = input.audience === 'staff' ? normaliseGroups(input.groups) : [];
  const access = resolveAccess(agents, table, { audience: input.audience, groups });

  const packDefault = asString(project?.defaultAgentId) || asString(project?.routingPolicy?.defaultAgentId) || asString(agents.find((a) => a.isDefault === true)?.agentId);
  // Which agent opens first: a locked one, the table's default, or the pack's own default when this person may use it. When none of
  // those applies the journey's stage decides at run time, which this preview does not guess at.
  const opening = access.lockedAgentId
    || access.defaultAgentId
    || (access.agents.some((a) => a.agentId === packDefault) ? packDefault : undefined);

  const known = new Set<string>();
  for (const team of teams) {
    for (const value of [team.teamId, team.name]) {
      const id = normaliseGroupId(value);
      if (id) known.add(id);
    }
  }
  const named = new Set<string>([...groups, ...(table?.rows ?? []).flatMap((row) => row.groups)]);

  return {
    audience: input.audience,
    groups,
    agents: access.agents.map((entry) => ({
      agentId: entry.agentId,
      name: asString(agents.find((a) => a.agentId === entry.agentId)?.name) || entry.agentId,
      level: entry.level,
      via: entry.via,
      opensFirst: entry.agentId === opening,
    })),
    ...(access.lockedAgentId ? { lockedAgentId: access.lockedAgentId } : {}),
    unknownGroups: [...named].filter((group) => !known.has(group)).sort(),
    knownGroups: [...known].sort(),
    hasTable: Boolean(table && table.rows.length > 0),
  };
}
