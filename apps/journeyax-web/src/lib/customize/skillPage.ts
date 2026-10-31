/**
 * The Skills page, the way it reads: skills in two groups (the ones that are always on, and the ones opened when a request fits), and,
 * on a skill's own page, its tools listed by the system they belong to ("Connectors & tools").
 */
import type { OverviewSkill, OverviewToolOption } from './types';

export interface SkillGroups { always: OverviewSkill[]; onDemand: OverviewSkill[] }

const byName = (a: OverviewSkill, b: OverviewSkill) => a.name.localeCompare(b.name);

export function groupSkills(skills: OverviewSkill[]): SkillGroups {
  return { always: skills.filter((skill) => skill.tier === 'always').sort(byName), onDemand: skills.filter((skill) => skill.tier !== 'always').sort(byName) };
}

export const matchesSkill = (skill: OverviewSkill, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !q || [skill.name, skill.description, skill.skillId].some((part) => part.toLowerCase().includes(q));
};

/** What the tool list calls the platform's own tools (the same name the skill form uses). */
export const BUILT_IN = 'Built-in tools';

export interface ToolGroup { system: string; tools: Array<{ id: string; label: string; changesData: boolean; switchedOff: boolean }> }

/**
 * A skill's tools by system. People who may change skills are sent the full tool list (names, systems), so those read plainly; for
 * anyone else a tool shows by its id, under its system's id (`salesforce.list_cases` under "salesforce"), or "Built-in tools" when it has none.
 */
export function groupSkillTools(tools: string[], options: OverviewToolOption[]): ToolGroup[] {
  const byId = new Map(options.map((option) => [option.id, option]));
  const groups = new Map<string, ToolGroup>();
  for (const id of tools) {
    const option = byId.get(id);
    const dot = id.indexOf('.');
    const system = option ? option.system : dot > 0 ? id.slice(0, dot) : BUILT_IN;
    const entry = { id, label: option?.label ?? (dot > 0 ? id.slice(dot + 1) : id), changesData: option?.sideEffect === 'write', switchedOff: option ? !option.enabled : false };
    const group = groups.get(system) ?? { system, tools: [] };
    group.tools.push(entry);
    groups.set(system, group);
  }
  return [...groups.values()].sort((a, b) => (a.system === BUILT_IN ? -1 : b.system === BUILT_IN ? 1 : a.system.localeCompare(b.system)));
}
