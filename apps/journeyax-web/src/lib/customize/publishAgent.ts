/**
 * Turning a draft agent into an agent of the live pack, safely.
 *
 * The rules: a draft can only ADD an agent (never change or remove one, never become the default), its id is new, its tools are
 * tools the platform really has, its skills are skills the pack really defines, and its model policy is one the pack already
 * uses. The caller applies the result through the project's own update and publication routes, which run the publication gate.
 */
import type { AgentDraftInput } from './drafts';
import { slugify, validateDraft } from './drafts';

export const LIMITS = { name: 60, purpose: 300, instructions: 8000, tools: 30, skills: 20 } as const;

export interface PublishContext {
  /** Agents already in the project's configuration, as stored. */
  existingAgents: Array<Record<string, any>>;
  /** Tool ids the platform offers. */
  knownTools: string[];
  /** Skill ids the pack defines. */
  knownSkills: string[];
  /** A model policy the pack already uses (the default agent's). */
  modelPolicyRef: string | undefined;
}

export type BuildResult = { ok: true; agent: Record<string, any>; agents: Array<Record<string, any>> } | { ok: false; errors: string[] };

export function buildPublishableAgent(input: AgentDraftInput, context: PublishContext): BuildResult {
  const errors: string[] = [];
  const checked = validateDraft(input);
  errors.push(...Object.values(checked.errors));
  const name = input.name.trim();
  if (name.length > LIMITS.name) errors.push(`The name is longer than ${LIMITS.name} characters.`);
  if (input.purpose.trim().length > LIMITS.purpose) errors.push(`The purpose is longer than ${LIMITS.purpose} characters.`);
  if (input.instructions.trim().length > LIMITS.instructions) errors.push(`The instructions are longer than ${LIMITS.instructions} characters.`);
  const tools = [...new Set(input.tools)];
  const skills = [...new Set(input.skills)];
  if (tools.length > LIMITS.tools) errors.push('Too many tools.');
  if (skills.length > LIMITS.skills) errors.push('Too many skills.');
  const unknownTool = tools.find((tool) => !context.knownTools.includes(tool));
  if (unknownTool) errors.push(`The platform has no tool called "${unknownTool}".`);
  const unknownSkill = skills.find((skill) => !context.knownSkills.includes(skill));
  if (unknownSkill) errors.push(`The pack has no skill called "${unknownSkill}".`);
  if (!context.modelPolicyRef) errors.push('The pack names no model policy to give the agent.');
  if (!Array.isArray(context.existingAgents) || context.existingAgents.length === 0) errors.push('The project has no agents to add to.');
  if (errors.length > 0) return { ok: false, errors };

  const taken = new Set(context.existingAgents.map((agent) => String(agent?.agentId || '')));
  const base = slugify(name);
  let agentId = base;
  for (let n = 2; taken.has(agentId); n++) agentId = `${base}_${n}`;
  const agent = {
    agentId,
    name,
    purpose: input.purpose.trim(),
    systemPromptTemplate: input.instructions.trim(),
    allowedTools: tools,
    skills,
    modelPolicyRef: context.modelPolicyRef,
    maxTurns: 5,
    handoffConditions: [] as string[],
    toolFirst: true,
  };
  return { ok: true, agent, agents: [...context.existingAgents, agent] };
}
