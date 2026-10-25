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

export interface AccessPreview {
  audience: PreviewAudience;
  groups: string[];
  agents: PreviewAgent[];
  lockedAgentId?: string;
  unknownGroups: string[];
  knownGroups: string[];
  hasTable: boolean;
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
  return {
    audience,
    groups: strings(raw.groups),
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
