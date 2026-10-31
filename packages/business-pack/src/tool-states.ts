/**
 * Whether a tool runs, waits for a yes, or is not offered, for this person, from the pack's tool state table. Pure and small: the agent
 * loop (what to offer), the tool runner (what to refuse or hold), the publication check and the "view as" preview all ask this one function.
 * See `schemas/tool-states.schema.ts` for the rules.
 */
import type { Principal } from '@journeyax/shared-types';
import { TOOL_STATES, type ToolState, type ToolStateRow, type ToolStates } from './schemas/tool-states.schema';
import { rowApplies } from './access';

const STRICTNESS: Record<ToolState, number> = Object.fromEntries(TOOL_STATES.map((state, index) => [state, index])) as Record<ToolState, number>;

export interface EffectiveToolState {
  state: ToolState;
  /** `open`: no row names the tool; `row`: a row decided. */
  via: 'open' | 'row';
  /** The shop's own question for an `ask`, when a row gave one. */
  prompt?: string;
}

/** 0: a row for everyone, 1: a row for all staff, 2: a row for named staff groups. */
function specificity(row: ToolStateRow): number {
  if (row.audience === 'shopper') return 0;
  return row.groups.length > 0 ? 2 : 1;
}

/** The state of one tool for one person. */
export function toolStateFor(toolId: string, table: ToolStates | undefined, principal: Pick<Principal, 'audience' | 'groups'>): EffectiveToolState {
  const rows = (table?.rows ?? []).filter((row) => row.toolId === toolId);
  if (rows.length === 0) return { state: 'allow', via: 'open' };
  const applicable = rows.filter((row) => rowApplies(row, principal));
  if (applicable.length === 0) return { state: 'blocked', via: 'row' };
  const top = Math.max(...applicable.map(specificity));
  const winners = applicable.filter((row) => specificity(row) === top);
  const strictest = winners.reduce((worst, row) => (STRICTNESS[row.state] > STRICTNESS[worst.state] ? row : worst), winners[0]);
  const prompt = winners.find((row) => row.state === strictest.state && row.prompt)?.prompt;
  return { state: strictest.state, via: 'row', ...(prompt ? { prompt } : {}) };
}

/** The tools of a list the person may be offered (not blocked), in the order given, with the state each has. */
export function offeredTools(toolIds: string[], table: ToolStates | undefined, principal: Pick<Principal, 'audience' | 'groups'>): Array<{ toolId: string } & EffectiveToolState> {
  return toolIds.map((toolId) => ({ toolId, ...toolStateFor(toolId, table, principal) })).filter((entry) => entry.state !== 'blocked');
}
