'use client';

/**
 * The journey's opening step (AUG-48): live brand research, shown for the
 * customer to CONFIRM before anything is designed.
 *
 * Everything here is a PROPOSAL — the colours are what we researched, mapped to
 * the brand's real palette, not applied to a product yet. The customer confirms
 * (or corrects) first. Sources are shown so they can verify, and the logo line
 * is explicit that we work from THEIR approved artwork, never a recreated mark.
 *
 * Colours are ALL theme variables (never hardcoded Caroma literals) so the card
 * follows each tenant's brand — the accent is the tenant's --gold, text/borders
 * its neutrals. The only raw hex is the researched colour swatch itself, which is
 * a real colour value, not chrome.
 */
import { useJourney } from '@/context/JourneyContext';
import type { SchoolResearch } from '@/lib/types';

const CONF: Record<string, { label: string; color: string }> = {
  high:   { label: 'High confidence',   color: 'var(--success)' },
  medium: { label: 'Medium confidence', color: 'var(--warning)' },
  low:    { label: 'Low confidence',    color: 'var(--warning)' },
};

export default function ResearchPanel() {
  const { state, dispatch } = useJourney();
  const r = state.schoolResearch as SchoolResearch | undefined;
  if (!r) return null;

  if (r.error) {
    return (
      <div style={{ padding: 24, maxWidth: 720 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Couldn’t research that school</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>{r.error}</p>
        <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>Tell me the team colours and I’ll build it from there.</p>
      </div>
    );
  }

  const conf = CONF[r.confidence || ''] || null;

  /* Swatch colour — the brand's REAL ink, never a guess (AUG-81).
   *
   * This used to fall back to the colour's WORD as a CSS colour, because
   * neither research nor our palette carried a value. That made "Blue" right
   * and "Bright Blue", "Vegas Gold" and "RA Gridiron Silver" white — a blank
   * chip beside the words "your team colours". The catalogue now derives the
   * true value from the brand's own renderer and ships it as `mappedTo.hex`,
   * so the guess is gone. A colour we genuinely cannot resolve renders as a
   * marked "no swatch" chip: an unknown colour must look unknown, because a
   * plausible wrong colour is the one thing a coach cannot catch. */
  const swatchHex = (c: { hex?: string; mappedTo?: { hex?: string } }): string | null => {
    const hex = c.mappedTo?.hex || c.hex;
    return hex && /^#?[0-9a-f]{6}$/i.test(hex) ? '#' + hex.replace(/^#/, '') : null;
  };

  /* The customer confirming must actually REACH the agent. dispatch(ADD_MESSAGE)
   * only appends text to local state — it never calls the API, so this button
   * looked alive and did nothing. ChatPanel exposes __journeySend as the send
   * bridge; use it, and fall back to the old dispatch so the text is never lost. */
  const send = (text: string) => {
    const bridge = typeof window !== 'undefined' ? (window as any).__journeySend : null;
    if (typeof bridge === 'function') bridge(text);
    else dispatch({ type: 'ADD_MESSAGE', role: 'user', text });
  };

  const confirm = () => {
    const cols = r.colours.map((c) => c.mappedTo?.name || c.name).filter(Boolean);
    send(`Yes, that's ${r.school} — ${r.team || r.mascot || ''}. Use ${cols.join(' and ')}. Show me the options.`);
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: 760 }}>
      <div style={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: 1, color: 'var(--gold)', fontWeight: 600 }}>
        What I found {r.cached ? '· from your saved research' : '· live'}
      </div>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', margin: '4px 0 2px' }}>
        {r.team || r.school}
      </h2>
      <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        {[r.mascot && `Mascot: ${r.mascot}`, r.location].filter(Boolean).join('  ·  ')}
        {conf && <span style={{ color: conf.color, marginLeft: 8, fontWeight: 600 }}>· {conf.label}</span>}
      </div>

      {/* Colours — researched, mapped to our real palette */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Team colours</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {r.colours.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', background: 'var(--surface)' }}>
              {(() => {
                const hex = swatchHex(c);
                return (
                  <span
                    title={hex ? `${c.mappedTo?.name || c.name} ${hex}` : 'We could not confirm this shade — we will match it before printing.'}
                    style={{
                      width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)',
                      background: hex
                        ? hex
                        // Hatched, not blank: an empty chip reads as a broken image.
                        : 'repeating-linear-gradient(45deg, var(--border) 0 4px, transparent 4px 8px)',
                    }}
                  />
                );
              })()}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                  {c.name}{c.role ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {c.role}</span> : null}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {/* Customers read colour NAMES and Pantone, never raw hex/chroma
                      codes — the swatch already shows the colour itself. */}
                  {c.pantone ? <>{c.pantone}</> : null}
                  {c.mappedTo && <span>{c.pantone ? ' · ' : ''}matched to <b>{c.mappedTo.name}</b></span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Design cues + logo/trademark */}
      {(r.styleWords?.length || r.typeface) && (
        <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
          {r.typeface && <div><b style={{ color: 'var(--text)' }}>Typeface:</b> {r.typeface}</div>}
          {!!r.styleWords?.length && <div style={{ marginTop: 4 }}><b style={{ color: 'var(--text)' }}>Design cues:</b> {r.styleWords.join(', ')}</div>}
        </div>
      )}
      {r.logo && (
        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)', background: 'var(--surface-alt)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
          <b style={{ color: 'var(--text)' }}>Logo:</b> we design in your colours and add <b>your approved artwork</b> — we don’t recreate the official mark.
          {r.logo.officialArtworkSource && <> Official artwork: <a href={r.logo.officialArtworkSource} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>source ↗</a></>}
        </div>
      )}

      {/* Sources — for trust */}
      {!!r.sources?.length && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)', marginBottom: 6 }}>Sources</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {r.sources.slice(0, 5).map((s, i) => (
              <li key={i}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>{s.title || s.url}</a></li>
            ))}
          </ul>
        </div>
      )}

      {/* The model's notes are RESEARCH voice — sourcing caveats, licensing
          warnings, "request written permission for commercial sale". Useful, but
          it was the largest block on the card and read as a legal warning to a
          coach picking jerseys. Collapse it behind a disclosure so the card stays
          a confirmation, not a memo. */}
      {r.notes && (
        <details style={{ marginTop: 14 }}>
          <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
            Research notes
          </summary>
          <p style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r.notes}</p>
        </details>
      )}

      <div style={{ marginTop: 22, display: 'flex', gap: 12 }}>
        <button onClick={confirm}
          style={{ background: 'var(--dark)', color: 'var(--surface)', border: 'none', borderRadius: 10, padding: '11px 20px', fontWeight: 600, cursor: 'pointer' }}>
          Looks right — show me the kit
        </button>
        <button onClick={() => send('That’s not quite right — let me give you the colours.')}
          style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 20px', fontWeight: 600, cursor: 'pointer' }}>
          Not quite
        </button>
      </div>
    </div>
  );
}
