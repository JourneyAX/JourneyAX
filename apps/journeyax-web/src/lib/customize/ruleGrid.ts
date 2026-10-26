/**
 * The page's side of the rules table: what has been edited, what to send, and how a status reads. No server code here (it never asks the
 * pack's rule function; the server did that when it built the table and checks again when it saves).
 */
import type { OverviewConnectorRules, SystemStatus, ToolState } from './types';

export interface RuleEdit { enabled: boolean; grid: Record<string, Record<string, ToolState>> }

/** The tools with at least one cell different from the table as it was read. */
export function changedTools(system: OverviewConnectorRules, edit: RuleEdit): string[] {
  return system.tools.map((tool) => tool.name).filter((name) => system.columns.some((column) => (edit.grid[name]?.[column.id] ?? 'blocked') !== system.grid[name]?.[column.id]));
}

/** How many cells are different from the table as it was read. */
export function countChanges(system: OverviewConnectorRules, edit: RuleEdit): number {
  let n = 0;
  for (const tool of system.tools) for (const column of system.columns) if ((edit.grid[tool.name]?.[column.id] ?? 'blocked') !== system.grid[tool.name]?.[column.id]) n += 1;
  return n;
}

/** What the server is sent: for each changed tool, the state of every column shown. */
export function rulesToSend(system: OverviewConnectorRules, edit: RuleEdit): { cells: Record<string, Record<string, ToolState>> } {
  const cells: Record<string, Record<string, ToolState>> = {};
  for (const name of changedTools(system, edit)) cells[name] = Object.fromEntries(system.columns.map((column) => [column.id, edit.grid[name]?.[column.id] ?? 'blocked']));
  return { cells };
}

/**
 * Sets a whole column: `reads` allows what only reads and asks first for what changes data, `ask` asks first for everything, `blocked`
 * blocks everything. (A tool that changes data is never simply allowed.)
 */
export function setColumn(system: OverviewConnectorRules, edit: RuleEdit, column: string, how: 'reads' | 'ask' | 'blocked'): RuleEdit {
  const grid = { ...edit.grid };
  for (const tool of system.tools) {
    const state: ToolState = how === 'blocked' ? 'blocked' : how === 'ask' ? 'ask' : tool.sideEffect === 'write' ? 'ask' : 'allow';
    grid[tool.name] = { ...grid[tool.name], [column]: state };
  }
  return { ...edit, grid };
}

/** A plain label for the connection check, and how worried to look. */
export function describeStatus(status: SystemStatus | undefined): { label: string; detail: string; tone: 'good' | 'bad' | 'unknown' } {
  if (!status) return { label: 'Connection not checked', detail: '', tone: 'unknown' };
  if (status.connected) return { label: 'Connected', detail: '', tone: 'good' };
  return { label: 'Not connected yet', detail: status.missing.length ? `needs ${status.missing.join(', ')}` : '', tone: 'bad' };
}

/** How many teams (not the administrators) may use at least one tool of the system, for the card. */
export function teamsWithAccess(system: OverviewConnectorRules): number {
  return system.columns.filter((column) => column.id !== 'administrators' && !column.note).filter((column) => system.tools.some((tool) => system.grid[tool.name]?.[column.id] !== 'blocked')).length;
}
