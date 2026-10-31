/**
 * Every tool a skill may name, for the skill editor: the platform's built-in tools, and the tools of each connected system with what each
 * team may do with them under the pack's rules.
 *
 * Server side only (it uses the pack's own rule function, so the page can never disagree with what the chat will do). The answer is plain
 * data for the page. A system that is switched off in the pack is still listed, marked as off, with the states its rules would give once
 * it is switched on; that way naming its tools is possible but the editor says it does nothing yet.
 */
import { connectorToolState, type ConnectorsExtension } from '@journeyax/business-pack';
import { describeTool, humaniseToolId, PLATFORM_TOOLS } from './tool-catalog';
import type { OverviewTeam, OverviewToolOption, ToolState } from './types';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The built-in tools a skill may name (the skill-opening tool itself is plumbing, not something to list). */
export const BUILT_IN_TOOL_IDS: string[] = Object.keys(PLATFORM_TOOLS).filter((id) => id !== 'use_skill');

/** Tool ids of the connected systems in a pack's connector table, written `system.tool`, switched-off systems included. */
export function connectorToolIds(extension: unknown): string[] {
  const connectors = isRecord(extension) && Array.isArray(extension.connectors) ? extension.connectors : [];
  const out: string[] = [];
  for (const connector of connectors) {
    if (!isRecord(connector)) continue;
    const id = str(connector.connectorId);
    if (!id) continue;
    for (const tool of Array.isArray(connector.tools) ? connector.tools : []) {
      const name = isRecord(tool) ? str(tool.name) : '';
      if (name) out.push(`${id}.${name}`);
    }
  }
  return out;
}

export function buildToolOptions(published: Json, teams: OverviewTeam[]): OverviewToolOption[] {
  const options: OverviewToolOption[] = BUILT_IN_TOOL_IDS.map((id) => {
    const tool = describeTool(id);
    return { id, label: tool.name, systemId: 'platform', system: 'Built-in tools', summary: tool.description, enabled: true };
  });

  const extension = isRecord(published.extensions) && isRecord(published.extensions.connectors) ? (published.extensions.connectors as unknown as ConnectorsExtension) : undefined;
  if (!extension || !Array.isArray(extension.connectors)) return options;
  // The rules are read as if every system were on, so a switched-off system still shows what its rules say.
  const asIfOn = { ...extension, connectors: extension.connectors.map((connector) => ({ ...connector, enabled: true })) } as ConnectorsExtension;

  for (const connector of extension.connectors) {
    const connectorId = str(connector.connectorId);
    if (!connectorId) continue;
    const system = str(connector.displayName) || connectorId;
    for (const tool of Array.isArray(connector.tools) ? connector.tools : []) {
      const name = str(tool?.name);
      if (!name) continue;
      const states: Record<string, ToolState> = { shopper: connectorToolState(asIfOn, connectorId, name, { audience: 'shopper', groups: [] }).state };
      for (const team of teams) states[team.id] = connectorToolState(asIfOn, connectorId, name, { audience: 'staff', groups: [team.id] }).state;
      options.push({
        id: `${connectorId}.${name}`,
        label: humaniseToolId(name),
        systemId: connectorId,
        system,
        summary: str(tool?.summary),
        sideEffect: tool?.sideEffect === 'write' ? 'write' : 'read',
        enabled: connector.enabled !== false,
        states,
      });
    }
  }
  return options;
}
