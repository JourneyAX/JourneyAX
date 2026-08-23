'use client';

import { useState } from 'react';
import { useCsr } from '@/context/CsrContext';
import { SIZES } from '@/lib/csr-types';

/**
 * Inline roster editing.
 *
 * This is the change a coach most often wants and the one the public reorder
 * flow does not obviously support — players graduate, numbers get reassigned,
 * sizes move. Editing it here is what keeps a roster-only change away from the
 * art queue entirely.
 */
export default function RosterEditor() {
  const { state, dispatch, diff } = useCsr();
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const draft = state.draft;
  if (!draft) return null;

  const removedNames = state.original
    ? state.original.roster.filter(o => !draft.roster.some(d => d.id === o.id))
    : [];

  /**
   * Coaches send rosters as spreadsheets and the columns are never in the same
   * order. Accept tab, comma or multiple spaces, and work out which column is
   * the number and which is the size rather than demanding a fixed layout.
   */
  const applyPaste = () => {
    const rows = paste.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed = rows.map((line, i) => {
      const cells = line.split(/\t|,|\s{2,}/).map(c => c.trim()).filter(Boolean);
      const sizeIdx = cells.findIndex(c => (SIZES as readonly string[]).includes(c.toUpperCase()));
      const numIdx = cells.findIndex((c, ci) => ci !== sizeIdx && /^\d{1,2}$/.test(c));
      const name = cells.filter((_, ci) => ci !== sizeIdx && ci !== numIdx).join(' ');
      return {
        id: `p${Date.now()}-${i}`,
        name: name || cells[0] || '',
        number: numIdx >= 0 ? cells[numIdx] : '',
        size: sizeIdx >= 0 ? cells[sizeIdx].toUpperCase() : 'M',
        change: 'added' as const,
      };
    });
    if (parsed.length) dispatch({ type: 'ROSTER_REPLACE', rows: parsed });
    setPaste('');
    setShowPaste(false);
  };

  return (
    <div className="csr-block">
      <div className="csr-block__head">
        <div>
          <span className="csr-src csr-src--coms">COMS</span>
          <h3 className="csr-block__title">Roster</h3>
        </div>
        <div className="csr-block__actions">
          <span className="csr-count">{draft.roster.length} units</span>
          {draft.roster.length > 0 && (
            <button
              className="csr-btn csr-btn--ghost"
              onClick={() => dispatch({ type: 'RUN_FIT_REVIEW' })}
            >
              Check sizes
            </button>
          )}
          <button className="csr-btn csr-btn--ghost" onClick={() => setShowPaste(v => !v)}>
            Paste from sheet
          </button>
          <button className="csr-btn csr-btn--ghost" onClick={() => dispatch({ type: 'ROSTER_ADD' })}>
            + Add
          </button>
        </div>
      </div>

      {showPaste && (
        <div className="csr-paste">
          <textarea
            className="csr-paste__area"
            value={paste}
            onChange={e => setPaste(e.target.value)}
            placeholder={'Paste any layout — tabs, commas or spaces.\nJ. Castellanos\t4\tS\nR. Patel, 5, M'}
            rows={5}
          />
          <div className="csr-paste__foot">
            <span className="csr-hint">Columns are detected — order does not matter.</span>
            <button className="csr-btn csr-btn--primary" onClick={applyPaste} disabled={!paste.trim()}>
              Replace roster
            </button>
          </div>
        </div>
      )}

      {draft.roster.length === 0 ? (
        <div className="csr-empty">No roster on this order.</div>
      ) : (
        <table className="csr-roster">
          <thead>
            <tr>
              <th className="csr-roster__num">#</th>
              <th>Player name</th>
              <th className="csr-roster__size">Size</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {draft.roster.map(r => (
              <tr key={r.id} className={r.change ? `is-${r.change}` : ''}>
                <td>
                  <input
                    className="csr-input csr-input--num"
                    value={r.number}
                    onChange={e => dispatch({ type: 'ROSTER_EDIT', id: r.id, field: 'number', value: e.target.value })}
                    aria-label="Player number"
                  />
                </td>
                <td>
                  <input
                    className="csr-input"
                    value={r.name}
                    onChange={e => dispatch({ type: 'ROSTER_EDIT', id: r.id, field: 'name', value: e.target.value })}
                    aria-label="Player name"
                  />
                </td>
                <td>
                  <select
                    className="csr-input csr-input--size"
                    value={r.size}
                    onChange={e => dispatch({ type: 'ROSTER_EDIT', id: r.id, field: 'size', value: e.target.value })}
                    aria-label="Size"
                  >
                    {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td>
                  <button
                    className="csr-roster__del"
                    onClick={() => dispatch({ type: 'ROSTER_REMOVE', id: r.id })}
                    aria-label={`Remove ${r.name || 'line'}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {removedNames.length > 0 && (
        <div className="csr-removed">
          Removed: {removedNames.map(r => `#${r.number} ${r.name}`).join(', ')}
        </div>
      )}

      {diff.rosterChanged && (
        <div className="csr-diffbar">
          {diff.added > 0 && <span className="csr-chip csr-chip--add">+{diff.added} added</span>}
          {diff.removed > 0 && <span className="csr-chip csr-chip--rem">−{diff.removed} removed</span>}
          {diff.edited > 0 && <span className="csr-chip csr-chip--edit">{diff.edited} edited</span>}
          <span className="csr-chip">{diff.qtyBefore} → {diff.qtyAfter} units</span>
        </div>
      )}
    </div>
  );
}
