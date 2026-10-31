/**
 * "View as" in Customize: which agents a shopper, or a member of staff in some groups, would get from the project's current settings.
 *
 * The work is done by the project service (the same function the runtime uses); this file only builds the question and reads the answer
 * defensively, so a changed or partial answer shows as "could not read" rather than breaking the page.
 */
export type PreviewAudience = 'shopper' | 'staff';

export interface PreviewAgent {
  agentId: string;
  name: string;
  level: 'available' | 'default' | 'required';
  via: 'open' | 'row';
  opensFirst: boolean;
}

export interface PreviewSkill {
  skillId: string;
  name: string;
  description: string;
  tier: 'always' | 'on_demand';
  level: 'available' | 'default' | 'required' | null;
  via: 'own' | 'row';
}

export interface PreviewTool {
  toolId: string;
  state: 'allow' | 'ask' | 'blocked';
  prompt?: string;
}

export interface PreviewPlugin {
  pluginId: string;
  name: string;
  description: string;
  available: boolean;
  level: 'available' | 'default' | 'required' | null;
}

export interface AccessPreview {
  audience: PreviewAudience;
  groups: string[];
  agents: PreviewAgent[];
  lockedAgentId?: string;
  unknownGroups: string[];
  knownGroups: string[];
  hasTable: boolean;
  skills: PreviewSkill[];
  hiddenSkills: Array<{ skillId: string; name: string }>;
  hasSkillTable: boolean;
  tools: PreviewTool[];
  plugins: PreviewPlugin[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(str).filter(Boolean) : []);

/** The query string for the preview: the audience, and (for staff) the groups, typed as a comma-separated list. */
export function previewQuery(audience: PreviewAudience, groupsText: string): string {
  const params = new URLSearchParams({ audience });
  const groups = audience === 'staff' ? groupsText.split(',').map((g) => g.trim()).filter(Boolean).join(',') : '';
  if (groups) params.set('groups', groups);
  return params.toString();
}

/** The answer of the project service, or undefined when it is not the shape expected. */
export function readAccessPreview(value: unknown): AccessPreview | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const audience = raw.audience === 'staff' ? 'staff' : raw.audience === 'shopper' ? 'shopper' : undefined;
  if (!audience || !Array.isArray(raw.agents)) return undefined;
  const agents: PreviewAgent[] = [];
  for (const entry of raw.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const agentId = str(a.agentId);
    const level = a.level === 'default' || a.level === 'required' ? a.level : a.level === 'available' ? 'available' : undefined;
    if (!agentId || !level) continue;
    agents.push({ agentId, name: str(a.name) || agentId, level, via: a.via === 'row' ? 'row' : 'open', opensFirst: a.opensFirst === true });
  }
  const skills: PreviewSkill[] = [];
  for (const entry of Array.isArray(raw.skills) ? raw.skills : []) {
    if (!entry || typeof entry !== 'object') continue;
    const k = entry as Record<string, unknown>;
    const skillId = str(k.skillId);
    if (!skillId) continue;
    const level = k.level === 'available' || k.level === 'default' || k.level === 'required' ? k.level : null;
    skills.push({ skillId, name: str(k.name) || skillId, description: str(k.description), tier: k.tier === 'on_demand' ? 'on_demand' : 'always', level, via: k.via === 'row' ? 'row' : 'own' });
  }
  const hiddenSkills = (Array.isArray(raw.hiddenSkills) ? raw.hiddenSkills : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({ skillId: str(entry.skillId), name: str(entry.name) || str(entry.skillId) }))
    .filter((entry) => entry.skillId);
  const tools: PreviewTool[] = (Array.isArray(raw.tools) ? raw.tools : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({ toolId: str(entry.toolId), state: entry.state === 'ask' || entry.state === 'blocked' ? entry.state : 'allow', ...(str(entry.prompt) ? { prompt: str(entry.prompt) } : {}) }) as PreviewTool)
    .filter((entry) => entry.toolId);
  const plugins: PreviewPlugin[] = (Array.isArray(raw.plugins) ? raw.plugins : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({ pluginId: str(entry.pluginId), name: str(entry.name) || str(entry.pluginId), description: str(entry.description), available: entry.available === true, level: entry.level === 'available' || entry.level === 'default' || entry.level === 'required' ? entry.level : null }) as PreviewPlugin)
    .filter((entry) => entry.pluginId);
  return {
    audience,
    groups: strings(raw.groups),
    plugins,
    tools,
    skills,
    hiddenSkills,
    hasSkillTable: raw.hasSkillTable === true,
    agents,
    ...(str(raw.lockedAgentId) ? { lockedAgentId: str(raw.lockedAgentId) } : {}),
    unknownGroups: strings(raw.unknownGroups),
    knownGroups: strings(raw.knownGroups),
    hasTable: raw.hasTable === true,
  };
}

/** One plain line for an agent in the preview. */
export function describePreviewAgent(agent: PreviewAgent): string {
  if (agent.level === 'required') return 'Locked to this agent';
  if (agent.opensFirst) return 'Opens first';
  if (agent.level === 'default') return 'Default for this group';
  return agent.via === 'open' ? 'Open to everyone' : 'Available';
}

/** The sentence under the list: what the preview does and does not tell. */
export function previewNote(preview: AccessPreview): string {
  if (!preview.hasTable) return 'No access table is set, so every agent is open to everyone. Add rows to give some agents to some groups only.';
  if (preview.agents.length === 0) return 'This person would have no agent. A shopper must always have at least one; check the table before publishing.';
  return 'This is what the settings say today. Anything you change here goes live only when you publish.';
}

/** One plain line for a skill in the preview. */
export function describePreviewSkill(skill: PreviewSkill): string {
  if (skill.level === 'required') return 'Always on, cannot be turned off';
  if (skill.level === 'default') return 'Installed for this group';
  if (skill.level === 'available') return 'Opened when a request fits';
  return skill.tier === 'always' ? 'Always on' : 'Opened when a request fits';
}

/** One plain line for what a tool may do for a person. */
export function describePreviewTool(tool: PreviewTool): string {
  if (tool.state === 'blocked') return 'Not available';
  if (tool.state === 'ask') return 'Asks first';
  return 'Runs freely';
}

/** One plain line for a plugin in the preview. */
export function describePreviewPlugin(plugin: PreviewPlugin): string {
  if (!plugin.available) return 'Not theirs';
  if (plugin.level === 'required') return 'Installed, cannot be turned off';
  if (plugin.level === 'default') return 'Installed for this group';
  return plugin.level === 'available' ? 'May use it' : 'Everyone has it';
}
