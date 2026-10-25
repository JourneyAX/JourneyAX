import { z } from 'zod';
import { AgentAccessLevelSchema, GroupIdSchema } from './access.schema';

/**
 * Who has which skill, and how (pack `extensions.skillAccess`). The same vocabulary as the agent access table, applied to skills.
 *
 * A skill with **no row** is carried exactly as its own `tier` says. A skill with **any row** is governed only by its rows: a person
 * matching none of them does not have it. Levels, from least to most:
 *  - `not_available`: the person does not have the skill (it is not in their prompt and `use_skill` refuses it).
 *  - `available`: on demand: only its name and description are in the prompt, and the agent opens it when a request fits.
 *  - `default`: installed for the person: its instructions are in the prompt on every turn.
 *  - `required`: the same for the agent, and a lower row cannot take it away.
 * A person who matches several rows gets the **highest** level.
 */
export const SkillAccessRowSchema = z.object({
  skillId: z.string().min(1).max(80),
  /** `shopper` rows apply to everyone; `staff` rows to members of staff only. */
  audience: z.enum(['shopper', 'staff']),
  /** For a `staff` row: the groups it applies to; empty means every member of staff. Must be empty for a `shopper` row. */
  groups: z.array(GroupIdSchema).max(50).default([]),
  level: AgentAccessLevelSchema,
}).strict();

export const SkillAccessSchema = z.object({
  rows: z.array(SkillAccessRowSchema).max(400),
}).strict();

export type SkillAccessRow = z.infer<typeof SkillAccessRowSchema>;
export type SkillAccess = z.infer<typeof SkillAccessSchema>;
