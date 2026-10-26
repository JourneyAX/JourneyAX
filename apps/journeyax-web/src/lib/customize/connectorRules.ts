/**
 * Who may do what with each tool of each connected system, as a table a person can read and change, and how a change to the table is
 * turned back into the pack's policy rows without changing what it did not touch.
 *
 * Server side only: it asks the pack's own rule function (`connectorToolState`) for every cell and to check every result, so the table can
 * never say something the chat would not do. The rules of the pack (see business-pack `connectors.schema.ts`):
 *  - three states: allow, ask first, blocked; a person in several groups gets the strictest of the rows that apply to them;
 *  - a tool with no row that applies to a person is blocked: new tools start blocked;
 *  - a row names one tool (or `*`: every tool of the system with no row of its own), says `staff` (named groups, or all staff) or `shopper`
 *    (everyone, staff too), and has one state.
 *
 * What a change writes: for each tool whose cells changed, ALL of its staff rows are replaced by one row per state (allow, ask first) naming
 * the columns in that state, plus a blocked row only where a default row or a row for everyone would otherwise let someone through. Rows for
 * everyone (shoppers too) and rows of tools that did not change are left exactly as they were. Writing a tool explicitly means a team that
 * is created later starts blocked for it, which is the pack's own default for anything new.
 */
import { connectorToolState, type ConnectorPolicyRow, type ConnectorsExtension } from '@journeyax/business-pack';
import { ADMIN_GROUP, normaliseGroupId } from '@journeyax/shared-types';
import { humaniseToolId } from './tool-catalog';
import { hashText } from './skillEdit';
import type { OverviewConnectorRules, OverviewTeam, RuleColumn, SystemStatus, ToolState } from './types';

const STATES: readonly ToolState[] = ['allow', 'ask', 'blocked'];
type Who = { audience: 'staff'; groups: string[] };
const staff = (group: string): Who => ({ audience: 'staff', groups: [group] });

/** The rules read as if every system were switched on, so a switched-off system still shows what its rules say. */
const asIfOn = (extension: ConnectorsExtension): ConnectorsExtension => ({ ...extension, connectors: extension.connectors.map((connector) => ({ ...connector, enabled: true })) });
const stateOf = (extension: ConnectorsExtension, connectorId: string, tool: string, group: string): ToolState => connectorToolState(extension, connectorId, tool, staff(group)).state;

/** A fingerprint of one system as the rules table sees it: its switch, its tools and every row that names it. */
export function connectorFingerprint(extension: ConnectorsExtension, connectorId: string): string | undefined {
  const connector = extension.connectors.find((entry) => entry.connectorId === connectorId);
  if (!connector) return undefined;
  const rows = (extension.policy ?? []).filter((row) => row.connectorId === connectorId).map((row) => JSON.stringify({ t: row.tool, a: row.audience, g: [...(row.groups ?? [])].sort(), s: row.state })).sort();
  return hashText(JSON.stringify({ e: connector.enabled !== false, s: connector.sample === true, t: connector.tools.map((tool) => `${tool.name}:${tool.sideEffect ?? 'read'}`), r: rows }));
}

function columnsFor(extension: ConnectorsExtension, connectorId: string, teams: OverviewTeam[]): RuleColumn[] {
  const columns: RuleColumn[] = teams.map((team) => ({ id: team.id, name: team.name }));
  columns.push({ id: ADMIN_GROUP, name: 'Administrators', note: 'The platform administrators, who are in no team.' });
  const known = new Set(columns.map((column) => column.id));
  const others = new Set<string>();
  for (const row of extension.policy ?? []) if (row.connectorId === connectorId && row.audience === 'staff') for (const group of row.groups ?? []) if (!known.has(group)) others.add(group);
  for (const group of [...others].sort()) columns.push({ id: group, name: group, note: 'Named by a rule, but not a team of this project.' });
  return columns;
}

/** Every system of the pack, switched on or off, with its rules table for the project's teams. */
export function buildConnectorRules(extension: ConnectorsExtension | undefined, teams: OverviewTeam[], statuses: Record<string, SystemStatus> = {}): OverviewConnectorRules[] {
  if (!extension || !Array.isArray(extension.connectors)) return [];
  const engine = asIfOn(extension);
  return extension.connectors.map((connector) => {
    const columns = columnsFor(extension, connector.connectorId, teams);
    const grid: OverviewConnectorRules['grid'] = {};
    for (const tool of connector.tools) {
      grid[tool.name] = {};
      for (const column of columns) grid[tool.name][column.id] = stateOf(engine, connector.connectorId, tool.name, column.id);
    }
    const rows = (extension.policy ?? []).filter((row) => row.connectorId === connector.connectorId);
    return {
      connectorId: connector.connectorId,
      name: connector.displayName,
      description: connector.description,
      owner: connector.owner,
      sample: connector.sample === true,
      enabled: connector.enabled !== false,
      tools: connector.tools.map((tool) => ({ name: tool.name, label: humaniseToolId(tool.name), summary: tool.summary ?? '', sideEffect: tool.sideEffect === 'write' ? 'write' : 'read' })),
      columns,
      grid,
      notes: {
        defaultRows: rows.filter((row) => row.tool === '*').length,
        allStaffRows: rows.filter((row) => row.audience === 'staff' && (row.groups ?? []).length === 0).length,
        everyoneRows: rows.filter((row) => row.audience === 'shopper').length,
      },
      base: connectorFingerprint(extension, connector.connectorId)!,
      ...(statuses[connector.connectorId] ? { status: statuses[connector.connectorId] } : {}),
    };
  });
}

export interface RulesChange {
  connectorId: string;
  /** Switch the system on or off. Absent: unchanged. */
  enabled?: boolean;
  /** For each tool that was edited, the state wanted for every column that was shown (tool -> column -> state). */
  cells?: Record<string, Record<string, ToolState>>;
}

export type RulesResult =
  | { ok: true; extension: ConnectorsExtension; changes: { enabled?: boolean; tools: string[]; cells: number }; warnings: string[] }
  | { ok: false; errors: string[] };

/** The connectors table after a change. Nothing is written here; the input is not modified. */
export function applyRulesChange(extension: ConnectorsExtension, change: RulesChange): RulesResult {
  const connector = extension.connectors.find((entry) => entry.connectorId === change.connectorId);
  if (!connector) return { ok: false, errors: [`The pack has no connected system called "${change.connectorId}".`] };
  const errors: string[] = [];
  const original = asIfOn(extension);
  let policy: ConnectorPolicyRow[] = [...(extension.policy ?? [])];
  const touched: string[] = [];
  let cellsChanged = 0;

  for (const [toolName, wanted] of Object.entries(change.cells ?? {})) {
    const tool = connector.tools.find((entry) => entry.name === toolName);
    if (!tool) { errors.push(`"${connector.displayName}" has no tool called "${toolName}".`); continue; }
    const desired: Record<string, ToolState> = {};
    for (const [group, state] of Object.entries(wanted)) {
      if (normaliseGroupId(group) !== group || !group) { errors.push(`"${group}" is not a valid team id.`); continue; }
      if (!STATES.includes(state)) { errors.push(`"${state}" is not a state (allow, ask or blocked).`); continue; }
      desired[group] = state;
    }
    const changed = Object.entries(desired).filter(([group, state]) => stateOf(original, connector.connectorId, toolName, group) !== state);
    if (changed.length === 0) continue;
    for (const [group, state] of changed) {
      if (state === 'allow' && tool.sideEffect === 'write') errors.push(`"${humaniseToolId(toolName)}" changes data in ${connector.displayName}, so it cannot simply be allowed for ${group}: choose Ask first or Blocked.`);
    }

    // Every group the tool's own staff rows name but the request does not show keeps the state it has now.
    const own = policy.filter((row) => row.connectorId === connector.connectorId && row.tool === toolName);
    const full: Record<string, ToolState> = { ...desired };
    for (const row of own) if (row.audience === 'staff') for (const group of row.groups ?? []) if (!(group in full)) full[group] = stateOf(original, connector.connectorId, toolName, group);

    const order = Object.keys(full).filter((group) => group !== ADMIN_GROUP).concat(ADMIN_GROUP in full ? [ADMIN_GROUP] : []);
    const rowFor = (state: ToolState, groups: string[]): ConnectorPolicyRow => ({ connectorId: connector.connectorId, tool: toolName, audience: 'staff', groups, state });
    const written: ConnectorPolicyRow[] = (['allow', 'ask'] as const).flatMap((state) => {
      const groups = order.filter((group) => full[group] === state);
      return groups.length ? [rowFor(state, groups)] : [];
    });

    const firstOwn = policy.findIndex((row) => row.connectorId === connector.connectorId && row.tool === toolName && row.audience === 'staff');
    const lastOfConnector = policy.reduce((last, row, index) => (row.connectorId === connector.connectorId ? index : last), -1);
    const without = policy.filter((row) => !(row.connectorId === connector.connectorId && row.tool === toolName && row.audience === 'staff'));
    const at = firstOwn >= 0 ? firstOwn : lastOfConnector >= 0 ? lastOfConnector + 1 : without.length;
    let next = [...without.slice(0, at), ...written, ...without.slice(at)];

    // The pack gives a tool no row says nothing about its default row's state, and a row for everyone applies to staff too: wherever that would let a
    // column through that should be blocked, say blocked explicitly; wherever it would stop a column getting less than it should, say so.
    const check = (rows: ConnectorPolicyRow[]) => order.filter((group) => stateOf(asIfOn({ ...extension, policy: rows }), connector.connectorId, toolName, group) !== full[group]);
    let wrong = check(next);
    const needBlocked = wrong.filter((group) => full[group] === 'blocked');
    if (needBlocked.length) {
      const blockedRow = rowFor('blocked', needBlocked);
      next = [...next.slice(0, at + written.length), blockedRow, ...next.slice(at + written.length)];
      wrong = check(next);
    }
    if (wrong.length) {
      errors.push(`A rule that applies to everyone keeps "${humaniseToolId(toolName)}" from being ${wrong.map((group) => `${full[group]} for ${group}`).join(', ')}. Remove that rule in the back office first.`);
      continue;
    }
    policy = next;
    touched.push(toolName);
    cellsChanged += changed.length;
  }
  if (errors.length) return { ok: false, errors };

  const connectors = extension.connectors.map((entry) => (entry.connectorId === connector.connectorId && change.enabled !== undefined ? { ...entry, enabled: change.enabled } : entry));
  const enabledChanged = change.enabled !== undefined && change.enabled !== (connector.enabled !== false);
  if (!enabledChanged && touched.length === 0) return { ok: false, errors: ['Nothing was changed.'] };
  const result: ConnectorsExtension = { ...extension, connectors, policy };

  const warnings: string[] = [];
  const nowOn = (connectors.find((entry) => entry.connectorId === connector.connectorId)?.enabled ?? true) !== false;
  if (nowOn && !policy.some((row) => row.connectorId === connector.connectorId && row.state !== 'blocked')) warnings.push(`${connector.displayName} is switched on but no team may use any of its tools.`);
  return { ok: true, extension: result, changes: { ...(enabledChanged ? { enabled: change.enabled } : {}), tools: touched, cells: cellsChanged }, warnings };
}
