/**
 * What the chat's "+" menu lists besides the connectors: the assistant's skills and plugins, and the words a picked skill puts in the
 * message box.
 *
 * The lists come from the Customize overview, which is the assistant's whole configuration, not "what this one person has". So they are
 * shown only to people who manage it (those who may see the skills' instructions or change them); everyone else keeps the connectors
 * list, which the server does cut down to what that person may use.
 */
import type { CustomizeOverview } from '../customize/types';

export interface PlusSkill { skillId: string; name: string; description: string; always: boolean }
export interface PlusPlugin { pluginId: string; name: string; summary: string }
export interface PlusModel { showLists: boolean; skills: PlusSkill[]; plugins: PlusPlugin[] }

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function plusMenuModel(overview: CustomizeOverview | undefined): PlusModel {
  if (!overview || !(overview.canViewInstructions || overview.canEdit)) return { showLists: false, skills: [], plugins: [] };
  const skills = overview.skills
    .map((skill): PlusSkill => ({ skillId: skill.skillId, name: skill.name, description: skill.description, always: skill.tier === 'always' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const plugins = overview.plugins
    .map((plugin): PlusPlugin => {
      const parts = [
        plugin.provides.agents.length ? count(plugin.provides.agents.length, 'agent') : '',
        plugin.provides.skills.length ? count(plugin.provides.skills.length, 'skill') : '',
        plugin.provides.connectors.length ? count(plugin.provides.connectors.length, 'system') : '',
        plugin.provides.forms.length ? count(plugin.provides.forms.length, 'form') : '',
      ].filter(Boolean);
      return { pluginId: plugin.pluginId, name: plugin.name, summary: parts.join(' · ') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { showLists: true, skills, plugins };
}

/** The message box after a skill is picked: the request to use it goes first, and what was already typed stays. */
export function skillPrompt(skillName: string, current: string): string {
  const lead = `Use the “${skillName}” skill: `;
  const rest = current.trimStart();
  if (rest.startsWith(lead)) return current;
  return `${lead}${rest}`;
}
