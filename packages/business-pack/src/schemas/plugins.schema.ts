import { z } from 'zod';
import { AgentAccessLevelSchema, GroupIdSchema } from './access.schema';

/**
 * Plugins (pack `extensions.plugins`): a named bundle of what the shop has built, switched on or off per group of people.
 *
 * A plugin does not contain anything: it names things the pack already defines (agents, skills, forms, connectors, tools). What it adds
 * is one switch for the whole bundle: "customer service" turns on the customer-service agent, its form and its connectors together, for
 * the people the shop chooses.
 *
 * Rules:
 *  - A thing that **no plugin names** is not governed by plugins at all, exactly as before.
 *  - A thing that **some plugin names** is available to a person only if at least one plugin that names it is available to them
 *    (and its own table, if it has one, still applies on top).
 *  - A plugin with **no access row** is available to everyone. With any row, a person matching none of its rows does not have it.
 *  - Levels as everywhere: `not_available` < `available` < `default` < `required`; the highest level among a person's rows wins.
 *    `default` and `required` also install the plugin's skills (always in the prompt) and make its agent the one that opens.
 */
const Slug = z.string().min(1).max(60).regex(/^[a-z][a-z0-9_-]*$/, 'use lower-case letters, digits, "-" or "_", starting with a letter');
const Ids = z.array(z.string().min(1).max(80)).max(40).default([]);

export const PluginSchema = z.object({
  pluginId: Slug,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
  version: z.string().min(1).max(20).optional(),
  provides: z.object({
    agents: Ids,
    skills: Ids,
    forms: Ids,
    connectors: Ids,
    /** Tools of the platform the plugin is about (for example a picture maker), by tool name. */
    tools: Ids,
  }).strict().default({ agents: [], skills: [], forms: [], connectors: [], tools: [] }),
}).strict();

export const PluginAccessRowSchema = z.object({
  pluginId: Slug,
  audience: z.enum(['shopper', 'staff']),
  groups: z.array(GroupIdSchema).max(50).default([]),
  level: AgentAccessLevelSchema,
}).strict();

export const PluginsSchema = z.object({
  plugins: z.array(PluginSchema).max(50),
  access: z.array(PluginAccessRowSchema).max(400).default([]),
}).strict();

export type Plugin = z.infer<typeof PluginSchema>;
export type PluginAccessRow = z.infer<typeof PluginAccessRowSchema>;
export type PluginsExtension = z.infer<typeof PluginsSchema>;
