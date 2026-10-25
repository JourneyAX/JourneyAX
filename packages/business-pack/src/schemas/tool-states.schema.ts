import { z } from 'zod';
import { GroupIdSchema } from './access.schema';

/**
 * What the assistant may do with each of its tools, for whom (pack `extensions.toolStates`). Three states, as in Claude:
 *  - `allow`: the tool runs when the assistant calls it.
 *  - `ask`: the assistant may call it, but nothing runs until the person in the chat says yes on a card ("Allow once").
 *  - `blocked`: the tool is not offered to the assistant at all.
 *
 * A tool with **no row** is allowed, exactly as before this table existed. A tool with **any row** is governed only by its rows: a
 * person matching none of them cannot use it.
 *
 * Which row wins for a person: the **most specific** one. A row for named staff groups beats a row for all staff, which beats a row for
 * everyone (shopper rows apply to everyone). Among rows of the same specificity the **strictest** wins (blocked, then ask, then allow).
 * So "everyone: ask, sales staff: allow" lets the sales team skip the card while shoppers still get it.
 */
export const TOOL_STATES = ['allow', 'ask', 'blocked'] as const;
export const ToolStateSchema = z.enum(TOOL_STATES);
export type ToolState = z.infer<typeof ToolStateSchema>;

export const ToolStateRowSchema = z.object({
  toolId: z.string().min(1).max(80),
  /** `shopper` rows apply to everyone; `staff` rows to members of staff only. */
  audience: z.enum(['shopper', 'staff']),
  /** For a `staff` row: the groups it applies to; empty means every member of staff. Must be empty for a `shopper` row. */
  groups: z.array(GroupIdSchema).max(50).default([]),
  state: ToolStateSchema,
  /** For `ask`: the question the card puts to the person, in the shop's own words ("Add these to your order?"). */
  prompt: z.string().min(1).max(300).optional(),
}).strict();

/** The words on the ask-first card, in the shop's own voice; anything left out uses the platform's plain default. */
export const ToolStateWordingSchema = z.object({
  heading: z.string().min(1).max(100).optional(),
  prompt: z.string().min(1).max(300).optional(),
  allow: z.string().min(1).max(40).optional(),
  deny: z.string().min(1).max(40).optional(),
  allowed: z.string().min(1).max(120).optional(),
  denied: z.string().min(1).max(120).optional(),
}).strict();

export const ToolStatesSchema = z.object({
  rows: z.array(ToolStateRowSchema).max(400),
  wording: ToolStateWordingSchema.optional(),
}).strict();

export type ToolStateRow = z.infer<typeof ToolStateRowSchema>;
export type ToolStates = z.infer<typeof ToolStatesSchema>;
