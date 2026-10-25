/**
 * Which plugins a person has, and so which of the pack's agents, skills, forms, connectors and tools are theirs. Pure and small, like
 * `resolveAccess`: the router, the prompt builder, the tool offer, the publication check and the "view as" preview all ask this one
 * function. See `schemas/plugins.schema.ts` for the rules.
 */
import type { Principal } from '@journeyax/shared-types';
import { AGENT_ACCESS_LEVELS, type AgentAccessLevel } from './schemas/access.schema';
import type { Plugin, PluginsExtension } from './schemas/plugins.schema';
import { rowApplies } from './access';

const RANK: Record<AgentAccessLevel, number> = Object.fromEntries(AGENT_ACCESS_LEVELS.map((level, index) => [level, index])) as Record<AgentAccessLevel, number>;

export type PluginKind = 'agents' | 'skills' | 'forms' | 'connectors' | 'tools';
export const PLUGIN_KINDS: readonly PluginKind[] = ['agents', 'skills', 'forms', 'connectors', 'tools'];

export interface PluginView {
  plugin: Plugin;
  /** The person's level, or `null` when no row governs the plugin (it is available to everyone). */
  level: Exclude<AgentAccessLevel, 'not_available'> | null;
  /** Whether the person has the plugin at all. */
  available: boolean;
}

/** Every plugin of the pack with whether this person has it. */
export function resolvePlugins(extension: PluginsExtension | undefined, principal: Pick<Principal, 'audience' | 'groups'>): PluginView[] {
  if (!extension || !Array.isArray(extension.plugins)) return [];
  return extension.plugins.map((plugin) => {
    const rows = (extension.access ?? []).filter((row) => row.pluginId === plugin.pluginId);
    if (rows.length === 0) return { plugin, level: null, available: true };
    const applicable = rows.filter((row) => rowApplies(row, principal));
    if (applicable.length === 0) return { plugin, level: null, available: false };
    const best = applicable.reduce((top, row) => (RANK[row.level] > RANK[top] ? row.level : top), 'not_available' as AgentAccessLevel);
    if (best === 'not_available') return { plugin, level: null, available: false };
    return { plugin, level: best, available: true };
  });
}

export interface PluginGate {
  /** True when the pack has plugins at all; without any, nothing is governed. */
  active: boolean;
  /** Is this thing this person's? A thing no plugin names is always theirs. */
  allows(kind: PluginKind, id: string): boolean;
  /** Does a plugin the person has at `default` or `required` name this thing (an installed skill, the opening agent)? */
  installs(kind: PluginKind, id: string): boolean;
  /** The ids of the kind that some plugin names and this person does not have. */
  hidden(kind: PluginKind): Set<string>;
  views: PluginView[];
}

export function pluginGate(extension: PluginsExtension | undefined, principal: Pick<Principal, 'audience' | 'groups'>): PluginGate {
  const views = resolvePlugins(extension, principal);
  const named = new Map<string, boolean>();
  const installed = new Set<string>();
  const key = (kind: PluginKind, id: string) => `${kind}\u0000${id}`;
  for (const view of views) {
    for (const kind of PLUGIN_KINDS) {
      for (const id of view.plugin.provides[kind] ?? []) {
        const k = key(kind, id);
        named.set(k, (named.get(k) ?? false) || view.available);
        if (view.available && (view.level === 'default' || view.level === 'required')) installed.add(k);
      }
    }
  }
  return {
    active: views.length > 0,
    allows: (kind, id) => !named.has(key(kind, id)) || named.get(key(kind, id)) === true,
    installs: (kind, id) => installed.has(key(kind, id)),
    hidden: (kind) => new Set([...named].filter(([k, ok]) => !ok && k.startsWith(`${kind}\u0000`)).map(([k]) => k.slice(kind.length + 1))),
    views,
  };
}
