/**
 * Builds the Customize overview from a published project config (the document project-service serves at `/published`).
 *
 * Pure and defensive: the published document is loose JSON, so every field is checked and anything missing is simply left
 * out. Nothing is derived to fill an empty tab — a pack with no skills gets an empty skills list, and the page says so.
 * Agent system prompts are never part of the overview.
 */
import { describeTool, PLATFORM_TOOLS } from './tool-catalog';
import type { CustomizeOverview, OverviewAgent, OverviewConnector, OverviewKnowledge, OverviewPlugin, OverviewSkill, OverviewSystem, OverviewTeam, OverviewToolOption, SkillAccessEntry } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const rec = (value: unknown): Json => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function readAgents(published: Json): OverviewAgent[] {
  const agents = list(published.agents).filter(isRecord).map((a, index): OverviewAgent => {
    const agentId = str(a.agentId) || `agent_${index + 1}`;
    return {
      agentId,
      name: str(a.name) || agentId,
      purpose: str(a.purpose),
      isDefault: a.isDefault === true,
      allowedTools: strings(a.allowedTools),
      skills: strings(a.skills),
      modelPolicyRef: str(a.modelPolicyRef),
      handoffConditions: strings(a.handoffConditions),
    };
  });
  // A pack names its default explicitly (`isDefault` or `defaultAgentId`); with neither and a single agent, that one is the default.
  const explicit = str(published.defaultAgentId);
  if (explicit && !agents.some((a) => a.isDefault)) for (const a of agents) a.isDefault = a.agentId === explicit;
  if (!agents.some((a) => a.isDefault) && agents.length === 1) agents[0].isDefault = true;
  return agents;
}

/** Skills live in the pack's `extensions.skills` (or a top-level `skills`); an entry without an id, name and description is skipped. */
export function readSkills(published: Json, includeInstructions: boolean): OverviewSkill[] {
  const raw: unknown[] = Array.isArray(published.skills) ? published.skills : list(rec(published.extensions).skills);
  const seen = new Set<string>();
  const out: OverviewSkill[] = [];
  const accessBySkill = new Map<string, SkillAccessEntry[]>();
  for (const row of list(rec(rec(published.extensions).skillAccess).rows)) {
    if (!isRecord(row)) continue;
    const id = str(row.skillId);
    const level = row.level === 'available' || row.level === 'default' || row.level === 'required' || row.level === 'not_available' ? row.level : undefined;
    if (!id || !level) continue;
    accessBySkill.set(id, [...(accessBySkill.get(id) || []), { audience: row.audience === 'staff' ? 'staff' : 'shopper', groups: strings(row.groups), level }]);
  }
  for (const s of raw) {
    if (!isRecord(s)) continue;
    const skillId = str(s.skillId);
    const name = str(s.name);
    if (!skillId || !name || seen.has(skillId)) continue;
    seen.add(skillId);
    const instructions = str(s.instructions);
    out.push({
      skillId,
      name,
      description: str(s.description),
      tier: s.tier === 'on_demand' ? 'on_demand' : 'always',
      tools: strings(s.tools),
      access: accessBySkill.get(skillId) || [],
      ...(includeInstructions && instructions ? { instructions } : {}),
    });
  }
  return out;
}

const LEVELS = ['not_available', 'available', 'default', 'required'] as const;

/** Plugins live in `extensions.plugins`; an entry without an id and a name is skipped. */
export function readPlugins(published: Json): OverviewPlugin[] {
  const ext = rec(rec(published.extensions).plugins);
  const rows = list(ext.access).filter(isRecord);
  const out: OverviewPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of list(ext.plugins)) {
    if (!isRecord(entry)) continue;
    const pluginId = str(entry.pluginId);
    const name = str(entry.name);
    if (!pluginId || !name || seen.has(pluginId)) continue;
    seen.add(pluginId);
    const provides = rec(entry.provides);
    out.push({
      pluginId,
      name,
      description: str(entry.description),
      provides: { agents: strings(provides.agents), skills: strings(provides.skills), forms: strings(provides.forms), connectors: strings(provides.connectors), tools: strings(provides.tools) },
      access: rows
        .filter((row) => str(row.pluginId) === pluginId && (LEVELS as readonly string[]).includes(str(row.level)))
        .map((row) => ({ audience: row.audience === 'staff' ? 'staff' as const : 'shopper' as const, groups: strings(row.groups), level: str(row.level) as OverviewPlugin['access'][number]['level'] })),
    });
  }
  return out;
}

/** The other systems the shop declared (`extensions.connectors.connectors`), with how many of their tools change data. */
export function readSystems(published: Json): OverviewSystem[] {
  const out: OverviewSystem[] = [];
  const seen = new Set<string>();
  for (const entry of list(rec(rec(published.extensions).connectors).connectors)) {
    if (!isRecord(entry) || entry.enabled === false) continue;
    const connectorId = str(entry.connectorId);
    const name = str(entry.displayName);
    if (!connectorId || !name || seen.has(connectorId)) continue;
    seen.add(connectorId);
    const tools = list(entry.tools).filter(isRecord);
    out.push({ connectorId, name, description: str(entry.description), owner: str(entry.owner), sample: entry.sample === true, tools: tools.length, writes: tools.filter((tool) => tool.sideEffect === 'write').length });
  }
  return out;
}

export function readKnowledge(published: Json): OverviewKnowledge {
  const model = rec(published.knowledgeModel);
  const sources = list(rec(published.knowledgeSource).sources).filter(isRecord).map((s, i) => ({
    id: str(s.id) || `source_${i + 1}`,
    label: str(s.label) || str(s.id) || `Source ${i + 1}`,
    kind: str(s.type) || 'source',
    ...(str(s.role) ? { role: str(s.role) } : {}),
    enabled: s.enabled !== false,
  }));
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const categories = strings(model.categories);
  return {
    ...(str(model.releaseId) ? { releaseId: str(model.releaseId) } : {}),
    ...(str(model.version) ? { version: str(model.version) } : {}),
    ...(typeof model.required === 'boolean' ? { required: model.required } : {}),
    ...(count(model.conceptCount) !== undefined ? { conceptCount: count(model.conceptCount) } : {}),
    ...(count(model.evidenceChunkCount) !== undefined ? { evidenceChunkCount: count(model.evidenceChunkCount) } : {}),
    ...(categories.length ? { categories } : {}),
    sources,
  };
}

/** The built-in tools: every one an agent may call (in the order agents list them), then the platform's remaining tools. */
export function buildConnectors(agents: OverviewAgent[]): OverviewConnector[] {
  const usedBy = new Map<string, string[]>();
  for (const agent of agents) {
    for (const tool of agent.allowedTools) {
      if (tool.includes('*')) continue; // a wildcard names no single tool
      usedBy.set(tool, [...(usedBy.get(tool) || []), agent.agentId]);
    }
  }
  const ids = [...usedBy.keys(), ...Object.keys(PLATFORM_TOOLS).filter((id) => !usedBy.has(id))];
  return ids.map((id) => ({ id, ...describeTool(id), kind: 'platform_tool' as const, usedBy: usedBy.get(id) || [] }));
}

export function buildOverview(tenantId: string, published: Json, opts: { canViewInstructions: boolean; canEdit?: boolean; teams?: OverviewTeam[]; toolOptions?: OverviewToolOption[] }): CustomizeOverview {
  const agents = readAgents(published);
  const version = str(published.packVersion);
  return {
    tenantId,
    ...(version ? { packVersion: version } : {}),
    agents,
    skills: readSkills(published, opts.canViewInstructions),
    plugins: readPlugins(published),
    systems: readSystems(published),
    knowledge: readKnowledge(published),
    connectors: buildConnectors(agents),
    canViewInstructions: opts.canViewInstructions,
    canEdit: opts.canEdit === true && opts.canViewInstructions,
    teams: opts.teams ?? [],
    toolOptions: opts.toolOptions ?? [],
  };
}

/** One plain line for a row of the skill access table, for the Skills tab. */
export function describeSkillAccess(entry: SkillAccessEntry): string {
  const who = entry.audience === 'shopper' ? 'Everyone' : entry.groups.length > 0 ? `Staff in ${entry.groups.join(', ')}` : 'All staff';
  const what = { not_available: 'does not have it', available: 'opens it when a request fits', default: 'has it installed', required: 'has it installed and cannot turn it off' }[entry.level];
  return `${who} ${what}`;
}

/** One plain line for a row of a plugin's access, for the Plugins tab. */
export function describePluginAccess(row: OverviewPlugin['access'][number]): string {
  const who = row.audience === 'shopper' ? 'Everyone' : row.groups.length > 0 ? `Staff in ${row.groups.join(', ')}` : 'All staff';
  const what = { not_available: 'does not have it', available: 'may use it', default: 'has it installed', required: 'has it installed and cannot turn it off' }[row.level];
  return `${who} ${what}`;
}
