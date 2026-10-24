import { z } from 'zod';

/**
 * A skill is a named, reusable piece of instructions an agent can carry (how to open a broad request, what to do after an
 * item is added, how to show a picture of the finished job). Skills are tenant data: the platform has no skill wording of
 * its own. An agent lists the skills it carries by id.
 *
 *   tier "always"     the instructions are part of the agent's prompt on every turn
 *   tier "on_demand"  only the name and description are in the prompt; the agent calls use_skill to read the instructions
 *                     when the customer's request calls for it (keeps the prompt short, lets the model decide)
 */
export const SkillDefinitionSchema = z.object({
  skillId: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'skillId is lower-case letters, digits, "-" or "_"'),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  tier: z.enum(['always', 'on_demand']).default('always'),
  /** Tools the skill relies on; shown in the customization screens, and checked against the agent's allowed tools. */
  tools: z.array(z.string()).default([]),
});

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

/** The skills of an agent, in the order the agent lists them; an id no skill defines is skipped (and reported by the validator). */
export function resolveAgentSkills(
  agent: { skills?: string[] | undefined } | undefined,
  skills: unknown,
): SkillDefinition[] {
  const ids = Array.isArray(agent?.skills) ? agent!.skills! : [];
  if (ids.length === 0 || !Array.isArray(skills)) return [];
  const byId = new Map<string, SkillDefinition>();
  for (const candidate of skills) {
    const parsed = SkillDefinitionSchema.safeParse(candidate);
    if (parsed.success) byId.set(parsed.data.skillId, parsed.data);
  }
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}
