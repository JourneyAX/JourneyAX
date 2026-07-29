'use client';

/**
 * Roster panel (AUG-32) — the step where a design becomes an order.
 *
 * The whole surface is organised around one refusal: a roster whose columns we
 * GUESSED cannot be priced until a human confirms them. A misread column is not
 * a display bug — it prints the wrong name on a child's shirt, or orders two
 * dozen garments in a size nobody wears. So the guess is shown, with its reason,
 * and the "price this" action stays disabled until someone says yes.
 *
 * Money is never computed here. Rows go to the quote engine as SKU + quantity
 * and it returns every figure (P0-04).
 */
import React, { useMemo, useState } from 'react';

interface Mapping {
  index: number; header: string;
  role: 'name' | 'number' | 'size' | 'ignore';
  garment?: string; because: string; confidence: 'high' | 'low';
}
interface Row {
  line: number; name?: string; number?: string;
  sizes: Record<string, string>; issues: string[];
}
interface Parsed {
  mapping?: Mapping[]; rows?: Row[]; playerCount?: number;
  needsConfirmation?: boolean; notes?: string[];
  sizeScaleConfigured?: boolean; error?: string;
}
interface QuoteLine {
  sku: string; name: string; quantity: number;
  unitPrice: number | null; lineTotal: number; reason?: string;
  sourceOfPrice: 'catalogue' | 'unavailable';
}
interface Quote {
  symbol: string; lines: QuoteLine[];
  subtotal: number; discount: number; tax: number; total: number;
}

export default function RosterPanel({
  project, garments, skuByGarment, sizeScale, teamName,
}: {
  project: string;
  garments: string[];
  skuByGarment: Record<string, string>;
  sizeScale: string[];
  teamName: string;
}) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<Parsed>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState('');

  const read = async () => {
    setBusy(true); setQuote(null); setQuoteError(''); setConfirmed(false);
    try {
      const res = await fetch(`/api/roster/parse?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, garments }),
      });
      const d: Parsed = await res.json();
      setParsed(d);
      setRows(d.rows || []);
      // Unambiguous columns need no ceremony; a guess does.
      setConfirmed(!d.needsConfirmation);
    } catch {
      setParsed({ error: 'Could not read that list.' });
    } finally { setBusy(false); }
  };

  /** Edits are local until priced — the roster is the dealer's working copy. */
  const edit = (line: number, patch: Partial<Row> | { size: [string, string] }) => {
    setRows((prev) => prev.map((r) => {
      if (r.line !== line) return r;
      if ('size' in patch) {
        const [garment, value] = (patch as any).size;
        return { ...r, sizes: { ...r.sizes, [garment]: value } };
      }
      return { ...r, ...(patch as Partial<Row>) };
    }));
    setQuote(null);   // any edit invalidates a price
  };

  const addRow = () => {
    setRows((prev) => [...prev, {
      line: Math.max(0, ...prev.map((r) => r.line)) + 1,
      name: '', number: '', sizes: {}, issues: [],
    }]);
    setQuote(null);
  };
  const removeRow = (line: number) => {
    setRows((prev) => prev.filter((r) => r.line !== line));
    setQuote(null);
  };

  /* Re-check locally as the dealer fixes rows, so the issue list reflects what
     is on screen rather than what was originally pasted. */
  const checked = useMemo(() => {
    const known = new Set(sizeScale.map((s) => s.toUpperCase()));
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const issues: string[] = [];
      if (!r.name?.trim()) issues.push('no player name');
      if (r.number) {
        const prev = seen.get(r.number);
        if (prev) issues.push(`number ${r.number} is already used on row ${prev}`);
        else seen.set(r.number, r.line);
      }
      for (const g of garments) {
        const v = (r.sizes[g] || '').toUpperCase();
        if (!v) { issues.push(`no ${g} size`); continue; }
        if (!known.size) issues.push(`size ${v} could not be checked`);
        else if (!known.has(v)) issues.push(`${v} is not a size this brand stocks`);
      }
      return { ...r, issues };
    });
  }, [rows, sizeScale, garments]);

  const problems = checked.filter((r) => r.issues.length);
  const units = checked.reduce(
    (n, r) => n + garments.filter((g) => r.sizes[g]).length, 0);
  const missingKit = !Object.keys(skuByGarment).length;
  const canPrice = confirmed && !problems.length && checked.length > 0 && !missingKit;

  const price = async () => {
    setBusy(true); setQuoteError('');
    try {
      const res = await fetch(`/api/roster/quote?project=${encodeURIComponent(project)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: checked, skuByGarment, title: `${teamName || 'Team'} — team order` }),
      });
      const d = await res.json();
      if (d?.error) { setQuoteError(d.error); setQuote(null); }
      else setQuote(d.quote);
    } catch {
      setQuoteError('Could not reach the quote service.');
    } finally { setBusy(false); }
  };

  /* ── styling ─────────────────────────────────────────────────────────── */
  const C = {
    wrap: { padding: 18, overflowY: 'auto', height: '100%', color: '#f2f2f2' } as React.CSSProperties,
    lbl: { fontSize: 9, fontWeight: 700, color: '#666', textTransform: 'uppercase',
           letterSpacing: '.09em', marginBottom: 8 } as React.CSSProperties,
    ta: { width: '100%', minHeight: 110, padding: 10, borderRadius: 8, fontSize: 12,
          border: '1px solid rgba(255,255,255,.12)', background: '#1c1c1c', color: '#f2f2f2',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', outline: 'none',
          resize: 'vertical' } as React.CSSProperties,
    btn: (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
      padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
      border: `1px solid ${primary ? '#e63329' : 'rgba(255,255,255,.14)'}`,
      background: primary ? '#e63329' : 'transparent', color: primary ? '#fff' : '#bbb',
    }),
    th: { textAlign: 'left', fontSize: 9, fontWeight: 700, color: '#666', textTransform: 'uppercase',
          letterSpacing: '.08em', padding: '0 8px 8px', borderBottom: '1px solid rgba(255,255,255,.08)' } as React.CSSProperties,
    td: { padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,.05)', fontSize: 12 } as React.CSSProperties,
    cell: { background: 'none', border: '1px solid transparent', color: '#f2f2f2',
            fontSize: 12, width: '100%', outline: 'none', padding: '3px 5px',
            borderRadius: 4, fontFamily: 'inherit' } as React.CSSProperties,
    sel: { background: '#1c1c1c', border: '1px solid rgba(255,255,255,.12)', color: '#f2f2f2',
           fontSize: 11, borderRadius: 4, padding: '3px 5px', outline: 'none' } as React.CSSProperties,
    note: (tone: 'warn' | 'info'): React.CSSProperties => ({
      fontSize: 11.5, lineHeight: 1.55, padding: '10px 12px', borderRadius: 8, marginTop: 12,
      border: `1px solid ${tone === 'warn' ? 'rgba(245,158,11,.35)' : 'rgba(255,255,255,.1)'}`,
      background: tone === 'warn' ? 'rgba(245,158,11,.08)' : '#141414',
      color: tone === 'warn' ? '#f59e0b' : '#999',
    }),
  };

  return (
    <div style={C.wrap}>
      <div style={C.lbl}>Paste your players</div>
      <textarea
        style={C.ta}
        placeholder={'Paste from a spreadsheet, or type:\n\nMarcus Johnson\t24\tL\nTyler Rodriguez\t7\tXL'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button style={C.btn(true, !text.trim() || busy)}
                disabled={!text.trim() || busy} onClick={read}>
          {busy ? 'Reading…' : 'Read this list'}
        </button>
        {!!checked.length && (
          <button style={C.btn(false, false)} onClick={addRow}>+ Add player</button>
        )}
        <div style={{ flex: 1 }} />
        {!!checked.length && (
          <span style={{ fontSize: 11, color: '#777' }}>
            {checked.length} player{checked.length === 1 ? '' : 's'} · {units} garment{units === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {parsed.error && <div style={C.note('warn')}>{parsed.error}</div>}

      {/* The guess, shown. Confirming it is a deliberate act, not a default. */}
      {!!parsed.mapping?.length && (
        <div style={C.note(parsed.needsConfirmation && !confirmed ? 'warn' : 'info')}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {parsed.needsConfirmation
              ? 'I had to guess what some columns were — please check before we price anything.'
              : 'Columns read from your headers.'}
          </div>
          {parsed.mapping.filter((m) => m.role !== 'ignore').map((m) => (
            <div key={m.index} style={{ marginBottom: 2 }}>
              Column {m.index + 1} → <strong>{m.role === 'size' ? `${m.garment} size` : m.role}</strong>
              {' '}<span style={{ opacity: 0.7 }}>({m.because})</span>
            </div>
          ))}
          {parsed.mapping.filter((m) => m.role === 'ignore').map((m) => (
            <div key={m.index} style={{ marginBottom: 2, opacity: 0.6 }}>
              Column {m.index + 1} → ignored <span>({m.because})</span>
            </div>
          ))}
          {parsed.needsConfirmation && !confirmed && (
            <button style={{ ...C.btn(true), marginTop: 10 }} onClick={() => setConfirmed(true)}>
              Yes, that is right
            </button>
          )}
        </div>
      )}

      {!!checked.length && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
          <thead>
            <tr>
              <th style={{ ...C.th, width: 28 }}>#</th>
              <th style={C.th}>Player</th>
              <th style={{ ...C.th, width: 70 }}>Number</th>
              {garments.map((g) => <th key={g} style={{ ...C.th, width: 96 }}>{g}</th>)}
              <th style={C.th}>Needs attention</th>
              <th style={{ ...C.th, width: 28 }} />
            </tr>
          </thead>
          <tbody>
            {checked.map((r) => (
              <tr key={r.line} style={{ background: r.issues.length ? 'rgba(245,158,11,.05)' : undefined }}>
                <td style={{ ...C.td, color: '#555', fontSize: 11 }}>{r.line}</td>
                <td style={C.td}>
                  <input style={C.cell} value={r.name || ''}
                         onChange={(e) => edit(r.line, { name: e.target.value })} />
                </td>
                <td style={C.td}>
                  <input style={{ ...C.cell, textAlign: 'center', color: '#e63329', fontWeight: 600 }}
                         value={r.number || ''}
                         onChange={(e) => edit(r.line, { number: e.target.value.replace(/\D/g, '') })} />
                </td>
                {garments.map((g) => (
                  <td key={g} style={C.td}>
                    {/* Sizes come from the brand's own scale, so an unstockable
                        size cannot be chosen here in the first place. */}
                    {sizeScale.length ? (
                      <select style={C.sel} value={(r.sizes[g] || '').toUpperCase()}
                              onChange={(e) => edit(r.line, { size: [g, e.target.value] } as any)}>
                        <option value="">—</option>
                        {sizeScale.map((s) => <option key={s} value={s.toUpperCase()}>{s}</option>)}
                      </select>
                    ) : (
                      <input style={C.cell} value={r.sizes[g] || ''}
                             onChange={(e) => edit(r.line, { size: [g, e.target.value.toUpperCase()] } as any)} />
                    )}
                  </td>
                ))}
                <td style={{ ...C.td, fontSize: 11, color: '#f59e0b' }}>{r.issues.join(' · ')}</td>
                <td style={C.td}>
                  <button onClick={() => removeRow(r.line)} title="Remove player"
                          style={{ background: 'none', border: 'none', color: '#555',
                                   cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!!checked.length && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button style={C.btn(true, !canPrice || busy)} disabled={!canPrice || busy} onClick={price}>
            {busy ? 'Pricing…' : 'Price this order'}
          </button>
          {/* Say WHY it is disabled — a dead button with no reason is its own bug. */}
          {!canPrice && (
            <span style={{ fontSize: 11, color: '#777' }}>
              {missingKit ? 'Choose a style on the Design tab first.'
                : !confirmed ? 'Confirm the columns above first.'
                : `${problems.length} row${problems.length === 1 ? '' : 's'} need attention.`}
            </span>
          )}
        </div>
      )}

      {quoteError && <div style={C.note('warn')}>{quoteError}</div>}

      {quote && (
        <div style={{ marginTop: 18, border: '1px solid rgba(255,255,255,.1)',
                      borderRadius: 10, padding: 14, background: '#141414' }}>
          <div style={C.lbl}>Order</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {quote.lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ ...C.td, color: '#999' }}>{l.name || l.sku}</td>
                  <td style={{ ...C.td, color: '#777', width: 90 }}>{l.reason}</td>
                  <td style={{ ...C.td, width: 50, textAlign: 'right' }}>×{l.quantity}</td>
                  <td style={{ ...C.td, width: 90, textAlign: 'right' }}>
                    {l.unitPrice == null
                      ? <span style={{ color: '#f59e0b' }}>on request</span>
                      : `${quote.symbol}${l.lineTotal.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12,
                        paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.1)',
                        fontSize: 15, fontWeight: 700 }}>
            <span>Total</span>
            <span style={{ color: '#e63329' }}>{quote.symbol}{quote.total.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 10.5, color: '#666', marginTop: 6 }}>
            Priced from the catalogue — {checked.length} players, {units} garments.
          </div>
        </div>
      )}
    </div>
  );
}
