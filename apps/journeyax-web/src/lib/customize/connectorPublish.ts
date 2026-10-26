/**
 * Saving the rules of one connected system from the Customize page, safely: the same read, save, publish-through-the-gate and put-back
 * routine as the skills editor (projectWrite.ts). A change made elsewhere since the page loaded (the back office, a second editor) is
 * noticed by the fingerprint of the system as the page read it and answered with 409, never overwritten.
 */
import type { ConnectorsExtension } from '@journeyax/business-pack';
import { applyRulesChange, connectorFingerprint, type RulesChange } from './connectorRules';
import { fail, ok, readProjectSettings, saveAndPublish, type ChangeResult, type WriteDeps } from './projectWrite';
import type { ToolState } from './types';

type Rec = Record<string, any>;

export interface RulesOp extends RulesChange { base: string }

/** The request body as an operation, or what is wrong with it. */
export function readRulesOp(body: unknown): RulesOp | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'The request had no body.' };
  const b = body as Rec;
  const connectorId = typeof b.connectorId === 'string' ? b.connectorId.slice(0, 64) : '';
  if (!connectorId) return { error: 'Say which connected system.' };
  const base = typeof b.base === 'string' && b.base ? b.base : '';
  if (!base) return { error: 'Reload the page: it did not say which version of the rules it was showing.' };
  const cells: Record<string, Record<string, ToolState>> = {};
  if (b.cells !== undefined) {
    if (!b.cells || typeof b.cells !== 'object' || Array.isArray(b.cells)) return { error: 'The rules were not in the shape expected.' };
    for (const [tool, row] of Object.entries(b.cells as Rec).slice(0, 100)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { error: 'The rules were not in the shape expected.' };
      cells[String(tool).slice(0, 64)] = Object.fromEntries(Object.entries(row as Rec).slice(0, 60).map(([group, state]) => [String(group).slice(0, 64), state as ToolState]));
    }
  }
  return { connectorId, base, ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}), ...(Object.keys(cells).length ? { cells } : {}) };
}

export async function changeRules(deps: WriteDeps, op: RulesOp): Promise<ChangeResult> {
  const read = await readProjectSettings(deps);
  if ('error' in read) return read.error;
  const current = read.project?.extensions?.connectors as ConnectorsExtension | undefined;
  if (!current || !Array.isArray(current.connectors)) return fail(409, 'This project has no connected systems to change. Reload the page.', { conflict: true });

  const now = connectorFingerprint(current, op.connectorId);
  if (now === undefined) return fail(409, 'That system is no longer in the settings. Reload the page.', { conflict: true });
  if (now !== op.base) return fail(409, 'This system\'s rules were changed somewhere else since you opened them (for example in the back office). Reload the page to see the latest, then make your change again.', { conflict: true });

  const done = applyRulesChange(current, op);
  if (done.ok === false) return fail(400, done.errors.join(' '));

  const name = current.connectors.find((entry) => entry.connectorId === op.connectorId)?.displayName ?? op.connectorId;
  const parts = [...(done.changes.enabled !== undefined ? [done.changes.enabled ? 'switched on' : 'switched off'] : []), ...(done.changes.tools.length ? [`rules changed for ${done.changes.tools.length} tool${done.changes.tools.length === 1 ? '' : 's'}`] : [])];
  const written = await saveAndPublish(deps, {
    patch: { extensions: { connectors: done.extension } },
    undo: { extensions: { connectors: current } },
    subject: 'rules',
    note: `${name}: ${parts.join(', ')}, from the Customize page`,
  });
  if (!written.ok) return written.result;
  return ok({ ok: true, connectorId: op.connectorId, changes: done.changes, warnings: done.warnings, ...(written.version ? { version: written.version } : {}) });
}
