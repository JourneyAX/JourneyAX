/**
 * Which connector tools a person may use, and in which state, from who they are and the pack's connector table.
 *
 * Pure and small on purpose, like `resolveAccess`: the agent tools, the dispatcher's caller, the publication gate and any "view as"
 * preview all ask this one function, so they cannot disagree. See `schemas/connectors.schema.ts` for the rules of the table.
 *
 * It accepts a table that has not been through the schema (a stored release): a missing `enabled` means enabled, missing `groups` means
 * none named, a missing `sideEffect` means read.
 */
import type { Principal } from '@journeyax/shared-types';
import { CONNECTOR_STATES, type ConnectorDefinition, type ConnectorPolicyRow, type ConnectorState, type ConnectorsExtension } from './schemas/connectors.schema';

export interface EffectiveConnectorTool {
  name: string;
  sideEffect: 'read' | 'write';
  summary?: string;
  state: ConnectorState;
  /** `tool` when a row names the tool, `default` when the connector's `*` row decided, `none` when no row applies (blocked). */
  via: 'tool' | 'default' | 'none';
}

export interface EffectiveConnector {
  connectorId: string;
  displayName: string;
  description: string;
  owner: string;
  mcpServerName: string;
  sample: boolean;
  /** Every approved tool, with this person's state for it. */
  tools: EffectiveConnectorTool[];
  /** True when at least one tool is allow or ask for this person. A connector that is not usable is not shown to the model. */
  usable: boolean;
}

/** Strictness, from the most open to the most closed: blocked beats ask, ask beats allow. */
const STRICTNESS: Record<ConnectorState, number> = Object.fromEntries(CONNECTOR_STATES.map((state, index) => [state, index])) as Record<ConnectorState, number>;

type Who = Pick<Principal, 'audience' | 'groups'>;
const ANONYMOUS_SHOPPER: Who = { audience: 'shopper', groups: [] };

/** Does this row apply to this person? Shopper rows apply to everyone; staff rows only to staff, and only to the groups they name (none named: all staff). */
export function connectorRowApplies(row: Pick<ConnectorPolicyRow, 'audience' | 'groups'>, principal: Who): boolean {
  if (row.audience === 'shopper') return true;
  if (principal.audience !== 'staff') return false;
  const groups = row.groups ?? [];
  return groups.length === 0 || groups.some((group) => principal.groups.includes(group));
}

function strictest(rows: ConnectorPolicyRow[]): ConnectorState {
  return rows.reduce<ConnectorState>((top, row) => (STRICTNESS[row.state] > STRICTNESS[top] ? row.state : top), 'allow');
}

export function mcpServerNameOf(connector: Pick<ConnectorDefinition, 'connectorId' | 'mcpServerName'>): string {
  return connector.mcpServerName || connector.connectorId;
}

/** The state of one tool of one connector for this person. `known` is false for a tool the pack does not list: it is blocked. */
export function connectorToolState(
  extension: ConnectorsExtension | undefined,
  connectorId: string,
  toolName: string,
  principal: Who = ANONYMOUS_SHOPPER,
): { state: ConnectorState; known: boolean; via: EffectiveConnectorTool['via'] } {
  const connector = extension?.connectors.find((entry) => entry.connectorId === connectorId);
  if (!connector || connector.enabled === false) return { state: 'blocked', known: Boolean(connector), via: 'none' };
  const known = connector.tools.some((tool) => tool.name === toolName);
  if (!known) return { state: 'blocked', known: false, via: 'none' };

  const rows = (extension?.policy ?? []).filter((row) => row.connectorId === connectorId && connectorRowApplies(row, principal));
  const own = rows.filter((row) => row.tool === toolName);
  if (own.length > 0) return { state: strictest(own), known: true, via: 'tool' };
  const fallback = rows.filter((row) => row.tool === '*');
  if (fallback.length > 0) return { state: strictest(fallback), known: true, via: 'default' };
  return { state: 'blocked', known: true, via: 'none' };
}

/** Every connector in the pack, with this person's state for each of its tools, in the pack's order. A pack without the table yields none. */
export function resolveConnectorPolicy(extension: ConnectorsExtension | undefined, principal: Who = ANONYMOUS_SHOPPER): EffectiveConnector[] {
  if (!extension) return [];
  return extension.connectors.map((connector) => {
    const tools: EffectiveConnectorTool[] = connector.tools.map((tool) => {
      const { state, via } = connectorToolState(extension, connector.connectorId, tool.name, principal);
      return { name: tool.name, sideEffect: tool.sideEffect ?? 'read', ...(tool.summary ? { summary: tool.summary } : {}), state, via };
    });
    return {
      connectorId: connector.connectorId,
      displayName: connector.displayName,
      description: connector.description,
      owner: connector.owner,
      mcpServerName: mcpServerNameOf(connector),
      sample: Boolean(connector.sample),
      tools,
      usable: connector.enabled !== false && tools.some((tool) => tool.state !== 'blocked'),
    };
  });
}

/** The connectors this person can use at all: what the model is told about. */
export function usableConnectors(extension: ConnectorsExtension | undefined, principal: Who = ANONYMOUS_SHOPPER): EffectiveConnector[] {
  return resolveConnectorPolicy(extension, principal).filter((connector) => connector.usable);
}
