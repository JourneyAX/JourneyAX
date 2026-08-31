'use client';

import { useState } from 'react';

/**
 * CDL Studio — the front half of the Custom Design Line flow, demoable.
 * Upload a custom jersey design → analyse (AI vision) → match to Augusta's
 * template library → USE/CREATE decision → (on USE) design it: apply colours,
 * team name & number onto the real template and see the applied render live,
 * pre-filled from the analysis. (Steps 1–4 of docs/augusta-cdl-spec.md.)
 */

type Tpl = {
  parentSku: string; name: string; sport: string; garmentType: string; division: string;
  sizes: string[]; colorCount: number; w2pUrlBase: string; renderable?: boolean;
};
type MatchRes = { template: Tpl; score: number; sizeOk: boolean; missingSizes: string[] };
type Analysis = {
  sport: string; garmentType: string; division: string; keywords: string[]; colors: string[];
  elements: { logo: boolean; name: boolean; number: boolean; allOverPattern: boolean };
  summary: string; provider: string;
};
type Resp = {
  analysis: Analysis;
  match: { decision: 'use' | 'create'; exists: boolean; best: MatchRes | null; results: MatchRes[]; libraryCount: number };
  error?: string;
};
type DesignLine = { slug: string; label: string; zones?: string[] };

const C = {
  bg: '#0e1014', card: '#1a1d24', edge: '#2a2e38', ink: '#f0f0f2', sub: '#9aa0aa',
  gold: '#e7b93b', green: '#2e9e5b', amber: '#e0902b', chip: '#242832', input: '#12141a',
};
const cutUrl = (t: Tpl, size = 'l') => t.w2pUrlBase.replace('{size}', size);

export default function CdlStudio() {
  const [imageUrl, setImageUrl] = useState('');
  const [preview, setPreview] = useState('');
  const [base64, setBase64] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<Resp | null>(null);
  const [err, setErr] = useState('');

  // ── Step 4 (design) state ──
  const [designLines, setDesignLines] = useState<DesignLine[]>([]);
  const [designLine, setDesignLine] = useState('');
  const [colours, setColours] = useState<string[]>(['NAVY', 'VEGAS GOLD', 'WHITE']);
  const [team, setTeam] = useState('TEAM');
  const [number, setNumber] = useState('00');
  const [designImg, setDesignImg] = useState('');
  const [glb, setGlb] = useState('');
  const [dLoading, setDLoading] = useState(false);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { const d = String(r.result); setBase64(d); setPreview(d); setImageUrl(''); };
    r.readAsDataURL(f);
  }

  async function run() {
    setErr(''); setResp(null); setDesignImg(''); setDesignLines([]); setLoading(true);
    if (imageUrl) setPreview(imageUrl);
    try {
      const body: any = { sizes: ['S', 'M', 'L', 'XL'] };
      if (base64) body.imageBase64 = base64; else body.imageUrl = imageUrl;
      const r = await fetch('/api/cdl/analyze?project=augusta', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'augusta' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setResp(j);
      // pre-fill design colours from the analysis
      const a: Analysis = j.analysis;
      if (a?.colors?.length) setColours([a.colors[0] || 'NAVY', a.colors[1] || 'VEGAS GOLD', a.colors[2] || 'WHITE']);
      // on USE, kick off the first designed render
      if (j.match?.decision === 'use' && j.match.best) design(j.match.best.template.parentSku, '', j.analysis);
    } catch (e: any) { setErr(e?.message || 'failed'); }
    finally { setLoading(false); }
  }

  async function design(sku: string, line?: string, a?: Analysis) {
    setDLoading(true);
    try {
      const cols = a?.colors?.length ? [a.colors[0], a.colors[1] || 'WHITE', a.colors[2] || 'BLACK'] : colours;
      const r = await fetch('/api/products/render?project=augusta', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'augusta' },
        body: JSON.stringify({ style: sku, colours: cols, text: { t2: team, t7: number }, designLine: line || designLine || undefined }),
      });
      const j = await r.json();
      if (j?.texture) setDesignImg(j.texture);
      if (j?.geometry?.glb) setGlb(j.geometry.glb);
      if (Array.isArray(j?.designLines) && j.designLines.length) {
        setDesignLines(j.designLines);
        if (!line && !designLine) setDesignLine(j.designLines[0].slug);
      }
    } catch { /* keep last */ }
    finally { setDLoading(false); }
  }

  const chip = (t: string, bg = C.chip, fg = C.ink) => (
    <span key={t} style={{ background: bg, color: fg, fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 999, marginRight: 6, marginBottom: 6, display: 'inline-block' }}>{t}</span>
  );
  const inputS: React.CSSProperties = { background: C.input, border: `1px solid ${C.edge}`, color: C.ink, padding: '8px 10px', borderRadius: 7, fontSize: 13 };
  const a = resp?.analysis; const m = resp?.match; const best = m?.best;
  const canDesign = m?.decision === 'use' && !!best;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: "'Space Grotesk',system-ui,sans-serif", padding: '32px 24px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <div style={{ color: C.gold, fontSize: 12, fontWeight: 700, letterSpacing: 2 }}>AUGUSTA · CDL STUDIO</div>
        <h1 style={{ fontSize: 30, margin: '6px 0 4px' }}>Custom design → template → design it</h1>
        <p style={{ color: C.sub, margin: '0 0 22px', fontSize: 14 }}>
          Upload a design. We read the garment, match the library, decide <b>use</b> vs <b>create</b>, then apply the design onto the real template.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
          <input value={imageUrl} onChange={(e) => { setImageUrl(e.target.value); setBase64(''); }}
            placeholder="Paste a jersey image URL…"
            style={{ flex: 1, minWidth: 320, background: C.card, border: `1px solid ${C.edge}`, color: C.ink, padding: '11px 14px', borderRadius: 8, fontSize: 14 }} />
          <label style={{ background: C.card, border: `1px solid ${C.edge}`, color: C.sub, padding: '11px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
            Upload…<input type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
          </label>
          <button onClick={run} disabled={loading || (!imageUrl && !base64)}
            style={{ background: C.gold, color: '#141018', border: 'none', padding: '11px 20px', borderRadius: 8, fontSize: 14, fontWeight: 800, cursor: loading ? 'wait' : 'pointer', opacity: (!imageUrl && !base64) ? 0.5 : 1 }}>
            {loading ? 'Analysing…' : 'Analyse & match'}
          </button>
        </div>
        {err && <div style={{ color: '#ff6b6b', marginBottom: 16 }}>⚠ {err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* uploaded */}
          <div style={{ background: C.card, border: `1px solid ${C.edge}`, borderRadius: 12, padding: 16 }}>
            <div style={{ color: C.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>UPLOADED DESIGN</div>
            {preview
              ? <img src={preview} alt="design" style={{ width: '100%', borderRadius: 8, background: '#000' }} />
              : <div style={{ height: 240, display: 'grid', placeItems: 'center', color: C.sub, border: `1px dashed ${C.edge}`, borderRadius: 8 }}>no image yet</div>}
            {a && (
              <div style={{ marginTop: 14 }}>
                <div style={{ marginBottom: 8 }}>{chip(a.sport, C.gold, '#141018')}{chip(a.garmentType)}{chip(a.division)}</div>
                <div style={{ color: C.sub, fontSize: 13, marginBottom: 8 }}>{a.summary}</div>
                <div>{a.keywords.map((k) => chip(k))}</div>
                <div style={{ color: C.sub, fontSize: 11, marginTop: 8 }}><i>{a.provider}</i></div>
              </div>
            )}
          </div>

          {/* match */}
          <div style={{ background: C.card, border: `1px solid ${C.edge}`, borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ color: C.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>MATCHED TEMPLATE</div>
              {m && (
                <span style={{ background: m.decision === 'use' ? C.green : C.amber, color: '#fff', fontSize: 12, fontWeight: 800, padding: '4px 12px', borderRadius: 999 }}>
                  {m.decision === 'use' ? 'USE EXISTING' : 'CREATE NEW'}
                </span>
              )}
            </div>
            {best ? (
              <div>
                <img src={cutUrl(best.template)} alt="cut pieces" style={{ width: '100%', borderRadius: 8, background: '#fff' }} />
                <div style={{ fontWeight: 700, marginTop: 10 }}>{best.template.name}</div>
                <div style={{ color: C.sub, fontSize: 12.5, marginTop: 2 }}>
                  {best.template.parentSku} · {best.template.sport} · sizes {best.template.sizes.join('/')}
                </div>
                <div style={{ color: C.sub, fontSize: 12, marginTop: 4 }}>
                  score {best.score} · sizes {best.sizeOk ? 'all present ✓' : `missing ${best.missingSizes.join(',')}`}
                </div>
              </div>
            ) : (
              <div style={{ height: 240, display: 'grid', placeItems: 'center', color: C.sub }}>
                {loading ? 'matching…' : 'run an analysis to see the match'}
              </div>
            )}
          </div>
        </div>

        {/* ── Step 4: DESIGN IT (USE branch) ── */}
        {canDesign && (
          <div style={{ background: C.card, border: `1px solid ${C.edge}`, borderRadius: 12, padding: 16, marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ color: C.sub, fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>DESIGN IT — applied on {best!.template.parentSku}</div>
              {glb && <a href={glb} target="_blank" rel="noreferrer" style={{ color: C.gold, fontSize: 12, textDecoration: 'none' }}>3D model (.glb) ↗</a>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 18 }}>
              {/* applied render */}
              <div style={{ minHeight: 260, display: 'grid', placeItems: 'center', background: '#fff', borderRadius: 8 }}>
                {designImg
                  ? <img src={designImg} alt="applied design" style={{ width: '100%', borderRadius: 8 }} />
                  : <span style={{ color: '#888' }}>{dLoading ? 'rendering…' : 'adjust and render'}</span>}
              </div>
              {/* controls */}
              <div>
                <label style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>DESIGN LINE</label>
                <select value={designLine} onChange={(e) => { setDesignLine(e.target.value); design(best!.template.parentSku, e.target.value); }}
                  style={{ ...inputS, width: '100%', margin: '4px 0 12px' }}>
                  {designLines.length === 0 && <option value="">(default)</option>}
                  {designLines.map((d) => <option key={d.slug} value={d.slug}>{d.label}</option>)}
                </select>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  {['Body', 'Accent 1', 'Accent 2'].map((lbl, i) => (
                    <div key={lbl} style={{ gridColumn: i === 2 ? '1 / span 2' : 'auto' }}>
                      <label style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>{lbl.toUpperCase()}</label>
                      <input value={colours[i] || ''} onChange={(e) => { const c = [...colours]; c[i] = e.target.value; setColours(c); }}
                        placeholder="colour name" style={{ ...inputS, width: '100%', marginTop: 4 }} />
                    </div>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 14 }}>
                  <div>
                    <label style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>TEAM NAME</label>
                    <input value={team} onChange={(e) => setTeam(e.target.value)} style={{ ...inputS, width: '100%', marginTop: 4 }} />
                  </div>
                  <div>
                    <label style={{ color: C.sub, fontSize: 11, fontWeight: 700 }}>NUMBER</label>
                    <input value={number} onChange={(e) => setNumber(e.target.value)} style={{ ...inputS, width: '100%', marginTop: 4 }} />
                  </div>
                </div>

                <button onClick={() => design(best!.template.parentSku, designLine)} disabled={dLoading}
                  style={{ background: C.gold, color: '#141018', border: 'none', padding: '10px 18px', borderRadius: 8, fontSize: 14, fontWeight: 800, cursor: dLoading ? 'wait' : 'pointer', width: '100%' }}>
                  {dLoading ? 'Rendering…' : 'Apply & render'}
                </button>
                <div style={{ color: C.sub, fontSize: 11, marginTop: 10 }}>
                  Colours pre-filled from your design. Edit and re-render live. Same texture drives the 3D model.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
