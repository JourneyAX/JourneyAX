/**
 * "View as": which agents a person of a given kind would get, from the project's current settings.
 *
 * Read-only and computed by the same function the runtime uses (`resolveAccess`), so the preview cannot disagree with what a person would
 * really get. It reads the project's settings (what a publish would send live), not the published pack, so an admin can check a table
 * before publishing it. The stage-by-stage routing of the journey is not previewed: only who may use which agent, and which opens first.
 */
import { resolveAccess, resolvePlugins, resolveSkillTiers, toolStateFor, AgentAccessSchema, PluginsSchema, SkillAccessSchema, SkillDefinitionSchema, ToolStatesSchema, type SkillDefinition } from '@journeyax/business-pack';
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
  /** The skills this person would have, each always in the prompt or opened when needed, and how that came about. */
  skills: AccessPreviewSkill[];
  /** Skills of the pack this person would not have. */
  hiddenSkills: Array<{ skillId: string; name: string }>;
  /** True when the project has a skill access table at all; without it every skill is carried as its own setting says. */
  hasSkillTable: boolean;
  /** The tools the tool state table names, with what each may do for this person: ask first, blocked, or allowed. */
  tools: Array<{ toolId: string; state: 'allow' | 'ask' | 'blocked'; prompt?: string }>;
  /** Every plugin of the pack, and whether this person has it (and at what level). */
  plugins: Array<{ pluginId: string; name: string; description: string; available: boolean; level: 'available' | 'default' | 'required' | null }>;
}

export interface AccessPreviewSkill {
  skillId: string;
  name: string;
  description: string;
  tier: 'always' | 'on_demand';
  /** The level a row gave, or null when no row governs the skill. */
  level: 'available' | 'default' | 'required' | null;
  via: 'own' | 'row';
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

  const skillList: SkillDefinition[] = (Array.isArray((project as any)?.skills) ? (project as any).skills : Array.isArray(project?.extensions?.skills) ? project!.extensions.skills : [])
    .map((candidate: unknown) => SkillDefinitionSchema.safeParse(candidate))
    .filter((parsed: { success: boolean }) => parsed.success)
    .map((parsed: { data: any }) => parsed.data);
  const skillTable = SkillAccessSchema.safeParse(project?.extensions?.skillAccess);
  const person = { audience: input.audience, groups };
  const effectiveSkills = resolveSkillTiers(skillList, skillTable.success ? skillTable.data : undefined, person);
  const haveSkill = new Set(effectiveSkills.map((entry) => entry.skill.skillId));
  for (const row of skillTable.success ? skillTable.data.rows : []) for (const group of row.groups) named.add(group);

  const toolTable = ToolStatesSchema.safeParse(project?.extensions?.toolStates);
  const namedTools = toolTable.success ? [...new Set(toolTable.data.rows.map((row) => row.toolId))] : [];
  if (toolTable.success) for (const row of toolTable.data.rows) for (const group of row.groups) named.add(group);

  const pluginTable = PluginsSchema.safeParse(project?.extensions?.plugins);
  const pluginViews = resolvePlugins(pluginTable.success ? pluginTable.data : undefined, person);
  if (pluginTable.success) for (const row of pluginTable.data.access) for (const group of row.groups) named.add(group);

  return {
    audience: input.audience,
    groups,
    plugins: pluginViews.map((view) => ({ pluginId: view.plugin.pluginId, name: view.plugin.name, description: view.plugin.description, available: view.available, level: view.level })),
    tools: namedTools.map((toolId) => ({ toolId, ...(() => { const effective = toolStateFor(toolId, toolTable.success ? toolTable.data : undefined, person); return { state: effective.state, ...(effective.prompt ? { prompt: effective.prompt } : {}) }; })() })),
    skills: effectiveSkills.map(({ skill, tier, level, via }) => ({ skillId: skill.skillId, name: skill.name, description: skill.description, tier, level, via })),
    hiddenSkills: skillList.filter((skill: { skillId: string }) => !haveSkill.has(skill.skillId)).map((skill: { skillId: string; name: string }) => ({ skillId: skill.skillId, name: skill.name })),
    hasSkillTable: Boolean(skillTable.success && skillTable.data.rows.length > 0),
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
