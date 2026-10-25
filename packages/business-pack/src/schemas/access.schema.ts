import { z } from 'zod';

/**
 * Who may use which agent (pack `extensions.agentAccess`).
 *
 * A table of rows, one per agent and audience. An agent with **no row** is open to everyone, exactly as before this table existed. An agent
 * with **any row** is governed only by its rows, so a staff-only agent is simply one that has staff rows and no shopper row.
 *
 * Levels, from least to most:
 *  - `not_available`: this row says the audience may not use the agent.
 *  - `available`: may use it, and may choose it.
 *  - `default`: opens by default for this audience (and may choose others that are available).
 *  - `required`: always routed here and may use no other agent (a locked home agent).
 * A person who matches several rows gets the **highest** level.
 */
export const AGENT_ACCESS_LEVELS = ['not_available', 'available', 'default', 'required'] as const;
export const AgentAccessLevelSchema = z.enum(AGENT_ACCESS_LEVELS);
export type AgentAccessLevel = z.infer<typeof AgentAccessLevelSchema>;

/** A group id as shared-types `normaliseGroupId` writes it. */
const GroupId = z.string().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9\-.:]*[a-z0-9])?$/, 'a group id uses lower-case letters, digits and - . :');

export const AgentAccessRowSchema = z.object({
  agentId: z.string().min(1).max(80),
  /** `shopper` rows apply to everyone (staff may use a shopper agent too); `staff` rows apply to members of staff only. */
  audience: z.enum(['shopper', 'staff']),
  /** For a `staff` row: the groups it applies to. Empty means every member of staff. Must be empty for a `shopper` row. */
  groups: z.array(GroupId).max(50).default([]),
  level: AgentAccessLevelSchema,
}).strict();

export const AgentAccessSchema = z.object({
  rows: z.array(AgentAccessRowSchema).max(200),
}).strict();

export type AgentAccessRow = z.infer<typeof AgentAccessRowSchema>;
export type AgentAccess = z.infer<typeof AgentAccessSchema>;
