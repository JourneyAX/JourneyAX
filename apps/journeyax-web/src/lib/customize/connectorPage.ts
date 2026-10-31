/**
 * The Connectors page, the way it reads: a table with one row per connector (its type and its status), and, for a connected system, a
 * page of its tools split into "Interactive tools" (they change data) and "Read-only tools", where one team at a time is given
 * Allow / Ask first / Blocked per tool or for a whole group.
 *
 * Pure: no page, no network. The rules themselves are the ones of the rules table (ruleGrid.ts); this only reshapes them.
 */
import { countChanges, describeStatus, type RuleEdit } from './ruleGrid';
import type { CustomizeOverview, OverviewConnectorRules, RuleColumn, ToolState } from './types';

export type RowTone = 'good' | 'warn' | 'off' | 'plain';

export interface ConnectorRow {
  /** `system:<id>` for a connected system, `builtin:<id>` for a tool the platform has built in. */
  key: string;
  kind: 'system' | 'builtin';
  id: string;
  name: string;
  description: string;
  /** "Connector" (a real system), "Data" (one the platform holds itself) or "Built in" (a tool of the platform). */
  type: string;
  status: { tone: RowTone; label: string; detail: string };
  tools?: number;
}

/** A system's name as people see it: the name and nothing else ("Salesforce Marketing Cloud (sample)" is "Salesforce Marketing Cloud"). */
export const tidyName = (name: string): string => String(name || '').replace(/\s*\((?:sample|demo)(?: data)?\)\s*$/i, '').trim();

export interface ConnectorRows { yours: ConnectorRow[]; discover: ConnectorRow[] }

const ADMIN_COLUMN = 'administrators';

type OverviewForRows = Pick<CustomizeOverview, 'connectors' | 'systems' | 'connectorRules'>;

/** Connected systems first (they are what people come for), then the platform's built-in tools; each in name order. */
const order = (a: ConnectorRow, b: ConnectorRow) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'system' ? -1 : 1);

/**
 * Yours = in use, Discover = there but not in use (a system switched off, a built-in tool no agent may call). People who may change the
 * rules see every connected system; everyone else sees the ones in use.
 */
export function connectorRows(overview: OverviewForRows): ConnectorRows {
  const yours: ConnectorRow[] = [];
  const discover: ConnectorRow[] = [];

  if (overview.connectorRules.length > 0) {
    for (const system of overview.connectorRules) {
      const check = describeStatus(system.status);
      // One plain word: Connected, Not connected, Off; a system the platform holds itself is simply Built in.
      const status: ConnectorRow['status'] = !system.enabled
        ? { tone: 'off', label: 'Off', detail: '' }
        : system.sample ? { tone: 'good', label: 'Built in', detail: '' }
        : check.tone === 'bad' ? { tone: 'warn', label: 'Not connected', detail: check.detail }
        : { tone: 'good', label: 'Connected', detail: '' };
      (system.enabled ? yours : discover).push({
        key: `system:${system.connectorId}`, kind: 'system', id: system.connectorId, name: tidyName(system.name), description: system.description,
        type: system.sample ? 'Data' : 'Connector', status, tools: system.tools.length,
      });
    }
  } else {
    for (const system of overview.systems) {
      yours.push({
        key: `system:${system.connectorId}`, kind: 'system', id: system.connectorId, name: tidyName(system.name), description: system.description,
        type: system.sample ? 'Data' : 'Connector', status: { tone: 'good', label: system.sample ? 'Built in' : 'Connected', detail: '' }, tools: system.tools,
      });
    }
  }

  for (const tool of overview.connectors) {
    const used = tool.usedBy.length > 0;
    (used ? yours : discover).push({
      key: `builtin:${tool.id}`, kind: 'builtin', id: tool.id, name: tool.name, description: tool.description, type: 'Built in',
      status: { tone: used ? 'good' : 'plain', label: used ? 'In use' : 'Not used', detail: '' },
    });
  }
  return { yours: yours.sort(order), discover: discover.sort(order) };
}

/** Rows matching a search. */
export function filterRows(rows: ConnectorRow[], query: string): ConnectorRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((row) => [row.name, row.description, row.id, row.type].some((part) => part.toLowerCase().includes(q))) : rows;
}

type Tool = OverviewConnectorRules['tools'][number];

/** The tools of a system in the two groups the page shows. */
export function splitTools(system: OverviewConnectorRules): { interactive: Tool[]; readOnly: Tool[] } {
  return { interactive: system.tools.filter((tool) => tool.sideEffect === 'write'), readOnly: system.tools.filter((tool) => tool.sideEffect !== 'write') };
}

/** The columns a person can pick to give rights to: the teams and the administrators (not a group the rules name that no team has). */
export function pickableColumns(system: OverviewConnectorRules): RuleColumn[] {
  const real = system.columns.filter((column) => !column.note || column.id === ADMIN_COLUMN);
  return real.length ? real : system.columns;
}

/** The team shown first: the first real team, else the first column. */
export function defaultColumn(system: OverviewConnectorRules): string {
  return (system.columns.find((column) => !column.note) ?? system.columns[0])?.id ?? '';
}

export const stateOf = (edit: RuleEdit, tool: string, column: string): ToolState => edit.grid[tool]?.[column] ?? 'blocked';

/** A tool that changes data can never simply be allowed: it asks first. */
const effective = (tool: Tool, state: ToolState): ToolState => (tool.sideEffect === 'write' && state === 'allow' ? 'ask' : state);

export function setToolState(edit: RuleEdit, tool: Tool, column: string, state: ToolState): RuleEdit {
  return { ...edit, grid: { ...edit.grid, [tool.name]: { ...edit.grid[tool.name], [column]: effective(tool, state) } } };
}

export function setGroupState(edit: RuleEdit, tools: Tool[], column: string, state: ToolState): RuleEdit {
  const grid = { ...edit.grid };
  for (const tool of tools) grid[tool.name] = { ...grid[tool.name], [column]: effective(tool, state) };
  return { ...edit, grid };
}

/** What a whole group is set to for a team: one state when every tool has it, else "custom". */
export function groupSetting(edit: RuleEdit, tools: Tool[], column: string): ToolState | 'custom' {
  if (tools.length === 0) return 'custom';
  const first = stateOf(edit, tools[0].name, column);
  return tools.every((tool) => stateOf(edit, tool.name, column) === first) ? first : 'custom';
}

/** What the confirmation says is about to change. */
export function describeEdit(system: OverviewConnectorRules, edit: RuleEdit): string {
  const settings = countChanges(system, edit);
  const parts = [
    ...(edit.enabled !== system.enabled ? [`switch ${system.name} ${edit.enabled ? 'ON' : 'OFF'}`] : []),
    ...(settings > 0 ? [`change ${settings} setting${settings === 1 ? '' : 's'}`] : []),
  ];
  return parts.join(' and ');
}

/** The one-line summary under a system's name: how many tools only read and how many change data. */
export function summarizeTools(system: OverviewConnectorRules): string {
  const { interactive, readOnly } = splitTools(system);
  const bits = [
    readOnly.length ? `${readOnly.length} read-only tool${readOnly.length === 1 ? '' : 's'}` : '',
    interactive.length ? `${interactive.length} interactive tool${interactive.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return bits.join(' · ') || 'No tools';
}
