'use client';

/**
 * CDL Layer Editor (CDL-9 in the storefront).
 *
 * The faithful proof is not editable — this panel is. The design is modelled as
 * separate LAYERS on an SVG canvas: the artwork (all-over), plus text (name /
 * number) and any uploaded logo, each a movable / scalable / editable object.
 * Export writes a layered SVG that opens in Adobe Illustrator with a real Layers
 * panel (same format the customer edits here), so nothing is baked.
 *
 * Honest scope: the artwork + logo are placed RASTER layers (move / scale / swap
 * / hide) and the text is live-editable; turning the raster into editable vector
 * PATHS is the tracer / Firefly step (needs Adobe access or potrace).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

const CANVAS = 1024;
const uid = () => Math.random().toString(36).slice(2, 9);

type Layer = {
  id: string;
  label: string;
  kind: 'image' | 'text';
  visible: boolean;
  x: number; y: number; scale: number;
  // image
  src?: string; w?: number; h?: number; blend?: string;
  // text
  text?: string; fontSize?: number; fill?: string; stroke?: string;
};

export default function DesignEditorPanel() {
  const { state, dispatch } = useJourney();
  const cfg = useStorefrontConfig() as any;
  const project = cfg?.projectId as string | undefined;
  const design = state.design || {};

  // The customer's design artwork (their proof / concept / uploaded look) is the
  // base all-over layer.
  const artworkSrc = useMemo(() => {
    const id = state.proofId || state.conceptId;
    return id ? `/api/cdl/concept/${encodeURIComponent(id)}${project ? `?project=${encodeURIComponent(project)}` : ''}` : '';
  }, [state.proofId, state.conceptId, project]);

  const [layers, setLayers] = useState<Layer[]>(() => {
    const base: Layer[] = [];
    if (artworkSrc) base.push({ id: uid(), label: 'Artwork (all-over)', kind: 'image', visible: true, x: 0, y: 0, scale: 1, src: artworkSrc, w: CANVAS, h: CANVAS });
    if (design.name) base.push({ id: uid(), label: 'Name', kind: 'text', visible: true, x: CANVAS / 2, y: CANVAS * 0.60, scale: 1, text: String(design.name), fontSize: 86, fill: '#ffffff', stroke: '#111111' });
    if (design.number) base.push({ id: uid(), label: 'Number', kind: 'text', visible: true, x: CANVAS * 0.82, y: CANVAS * 0.28, scale: 1, text: String(design.number), fontSize: 120, fill: '#ffd400', stroke: '#111111' });
    return base;
  });
  const [selId, setSelId] = useState<string | null>(null);
  const sel = layers.find((l) => l.id === selId) || null;

  const conceptUrl = useCallback((id: string) =>
    `/api/cdl/concept/${encodeURIComponent(id)}${project ? `?project=${encodeURIComponent(project)}` : ''}`, [project]);

  // Compose from SEPARATE layers: split the design into a pattern-only base + an
  // isolated logo (server image-edit), so the editable name/number no longer sit
  // on top of a baked-in copy. Runs once when the editor opens; falls back to the
  // composed proof if it can't separate them.
  const [decomposing, setDecomposing] = useState(false);
  const decomposed = useRef(false);
  useEffect(() => {
    const sourceId = state.proofId || state.conceptId;
    if (!sourceId || decomposed.current) return;
    decomposed.current = true;   // single-run guard (survives StrictMode double-effect)
    (async () => {
      setDecomposing(true);
      try {
        const res = await fetch(`/api/cdl/decompose${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(project ? { 'X-Tenant-ID': project } : {}) },
          body: JSON.stringify({ sourceId }),
        });
        const j = await res.json().catch(() => ({}));
        if (j?.ok && (j.patternId || j.logoId)) {
          const next: Layer[] = [];
          if (j.patternId) next.push({ id: uid(), label: 'Artwork (all-over)', kind: 'image', visible: true, x: 0, y: 0, scale: 1, src: conceptUrl(j.patternId), w: CANVAS, h: CANVAS });
          if (j.logoId) next.push({ id: uid(), label: 'Logo', kind: 'image', visible: true, x: CANVAS * 0.28, y: CANVAS * 0.30, scale: 1, src: conceptUrl(j.logoId), w: CANVAS * 0.44, h: CANVAS * 0.44, blend: 'multiply' });
          if (design.name) next.push({ id: uid(), label: 'Name', kind: 'text', visible: true, x: CANVAS / 2, y: CANVAS * 0.72, scale: 1, text: String(design.name), fontSize: 82, fill: '#ffffff', stroke: '#111111' });
          if (design.number) next.push({ id: uid(), label: 'Number', kind: 'text', visible: true, x: CANVAS * 0.82, y: CANVAS * 0.22, scale: 1, text: String(design.number), fontSize: 120, fill: '#ffd400', stroke: '#111111' });
          if (next.length) setLayers(next);
        }
        // else keep the fallback (composed-proof) seed
      } catch { /* keep fallback */ }
      finally { setDecomposing(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const patch = useCallback((id: string, p: Partial<Layer>) => {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
  }, []);

  // px → canvas units
  const toCanvas = (dxPx: number, dyPx: number) => {
    const r = svgRef.current?.getBoundingClientRect();
    const k = r ? CANVAS / r.width : 1;
    return [dxPx * k, dyPx * k] as const;
  };

  const onPointerDown = (e: React.PointerEvent, l: Layer) => {
    e.stopPropagation();
    setSelId(l.id);
    drag.current = { id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const [dx, dy] = toCanvas(e.clientX - drag.current.sx, e.clientY - drag.current.sy);
    patch(drag.current.id, { x: drag.current.ox + dx, y: drag.current.oy + dy });
  };
  const onPointerUp = () => { drag.current = null; };

  const addText = () => {
    const l: Layer = { id: uid(), label: 'Text', kind: 'text', visible: true, x: CANVAS / 2, y: CANVAS / 2, scale: 1, text: 'TEXT', fontSize: 90, fill: '#ffffff', stroke: '#111111' };
    setLayers((ls) => [...ls, l]); setSelId(l.id);
  };
  const onUploadLogo = (file?: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const l: Layer = { id: uid(), label: 'Logo', kind: 'image', visible: true, x: CANVAS * 0.30, y: CANVAS * 0.30, scale: 1, src: String(reader.result || ''), w: CANVAS * 0.40, h: CANVAS * 0.40 };
      setLayers((ls) => [...ls, l]); setSelId(l.id);
    };
    reader.readAsDataURL(file);
  };
  const move = (id: string, dir: -1 | 1) => setLayers((ls) => {
    const i = ls.findIndex((l) => l.id === id); if (i < 0) return ls;
    const j = i + dir; if (j < 0 || j >= ls.length) return ls;
    const c = [...ls]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });
  const del = (id: string) => { setLayers((ls) => ls.filter((l) => l.id !== id)); if (selId === id) setSelId(null); };

  // Build a layered SVG (Illustrator layers) with images embedded as data URIs.
  const buildSvg = useCallback(async () => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const asDataUri = async (src: string) => {
      if (src.startsWith('data:')) return src;
      const r = await fetch(src); const b = await r.blob();
      return await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(b); });
    };
    const parts: string[] = [];
    for (const l of layers) {
      if (!l.visible) continue;
      if (l.kind === 'image' && l.src) {
        const uri = await asDataUri(l.src);
        const w = (l.w || CANVAS) * l.scale, h = (l.h || CANVAS) * l.scale;
        const st = l.blend ? ` style="mix-blend-mode:${l.blend}"` : '';
        parts.push(`  <g id="${esc(l.label)}" inkscape:label="${esc(l.label)}" inkscape:groupmode="layer">\n    <image x="${l.x}" y="${l.y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"${st} xlink:href="${uri}"/>\n  </g>`);
      } else if (l.kind === 'text') {
        const fs = (l.fontSize || 90) * l.scale;
        parts.push(`  <g id="${esc(l.label)}" inkscape:label="${esc(l.label)} (editable)" inkscape:groupmode="layer">\n    <text x="${l.x}" y="${l.y}" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="${fs}" fill="${l.fill || '#fff'}" stroke="${l.stroke || '#111'}" stroke-width="${Math.max(2, fs * 0.03)}" paint-order="stroke">${esc(l.text || '')}</text>\n  </g>`);
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">\n  <title>CDL editable design document</title>\n${parts.join('\n')}\n</svg>\n`;
  }, [layers]);

  const [busy, setBusy] = useState(false);
  const exportSvg = async () => {
    setBusy(true);
    try {
      const svg = await buildSvg();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(design.name || 'design').toString().replace(/\s+/g, '_')}_editable.svg`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    } finally { setBusy(false); }
  };

  const btn: React.CSSProperties = { border: '1px solid var(--border)', background: 'var(--surface, #fff)', color: 'var(--text)', borderRadius: 8, padding: '6px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
  const muted = 'var(--text-secondary, #888)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Design editor <span style={{ fontSize: 11.5, fontWeight: 400, color: muted }}>· layers you can move, edit &amp; export</span></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button style={btn} onClick={() => dispatch({ type: 'SET_PHASE', phase: 'configurator' })}>← Preview</button>
          <button style={{ ...btn, background: 'var(--color-primary, #C8102E)', color: '#fff', borderColor: 'transparent' }} disabled={busy} onClick={exportSvg}>{busy ? 'Exporting…' : 'Export editable file (SVG)'}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>
        {/* Canvas */}
        <div style={{ position: 'relative', flex: 1, minWidth: 0, borderRadius: 12, overflow: 'hidden', background: '#fff', border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
          {decomposing && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 2, background: 'rgba(255,255,255,0.82)', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Separating your design into editable layers…</div>
                <div style={{ fontSize: 12, color: muted, marginTop: 6 }}>Splitting the pattern, logo and lettering so each can be moved and edited on its own.</div>
              </div>
            </div>
          )}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${CANVAS} ${CANVAS}`}
            style={{ width: '100%', height: '100%', touchAction: 'none' }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerDown={() => setSelId(null)}
          >
            <rect x={0} y={0} width={CANVAS} height={CANVAS} fill="#f4f4f5" />
            {layers.map((l) => l.visible && (
              <g key={l.id} onPointerDown={(e) => onPointerDown(e, l)} style={{ cursor: 'move' }}>
                {l.kind === 'image' && l.src && (
                  <image x={l.x} y={l.y} width={(l.w || CANVAS) * l.scale} height={(l.h || CANVAS) * l.scale} href={l.src} preserveAspectRatio="xMidYMid meet" style={l.blend ? { mixBlendMode: l.blend as any } : undefined} />
                )}
                {l.kind === 'text' && (
                  <text x={l.x} y={l.y} textAnchor="middle" fontFamily="Arial Black, Arial, sans-serif" fontWeight={900}
                        fontSize={(l.fontSize || 90) * l.scale} fill={l.fill} stroke={l.stroke} strokeWidth={Math.max(2, (l.fontSize || 90) * l.scale * 0.03)} paintOrder="stroke">{l.text}</text>
                )}
                {sel?.id === l.id && l.kind === 'image' && (
                  <rect x={l.x} y={l.y} width={(l.w || CANVAS) * l.scale} height={(l.h || CANVAS) * l.scale} fill="none" stroke="#2b6cff" strokeWidth={4} strokeDasharray="10 8" />
                )}
              </g>
            ))}
          </svg>
        </div>

        {/* Controls */}
        <div style={{ width: 230, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...btn, flex: 1 }} onClick={addText}>+ Text</button>
            <label style={{ ...btn, flex: 1, textAlign: 'center' }}>
              + Logo<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { onUploadLogo(e.target.files?.[0]); e.currentTarget.value = ''; }} />
            </label>
          </div>

          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: muted, marginTop: 2 }}>Layers</div>
          {[...layers].reverse().map((l) => (
            <div key={l.id} onClick={() => setSelId(l.id)}
                 style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 7px', borderRadius: 8, cursor: 'pointer',
                          border: `1px solid ${sel?.id === l.id ? '#2b6cff' : 'var(--border)'}`, background: sel?.id === l.id ? 'rgba(43,108,255,0.06)' : 'transparent' }}>
              <button title="toggle" onClick={(e) => { e.stopPropagation(); patch(l.id, { visible: !l.visible }); }} style={{ border: 'none', background: 'none', cursor: 'pointer', opacity: l.visible ? 1 : 0.35, fontSize: 13 }}>{l.visible ? '👁' : '🚫'}</button>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.label}{l.kind === 'text' ? `: ${l.text}` : ''}</span>
              <button title="up" onClick={(e) => { e.stopPropagation(); move(l.id, 1); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: muted }}>↑</button>
              <button title="down" onClick={(e) => { e.stopPropagation(); move(l.id, -1); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: muted }}>↓</button>
              <button title="delete" onClick={(e) => { e.stopPropagation(); del(l.id); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#c0392b' }}>✕</button>
            </div>
          ))}

          {sel && (
            <div style={{ marginTop: 4, padding: 8, border: '1px solid var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: muted }}>Edit: {sel.label}</div>
              {sel.kind === 'text' && (
                <>
                  <input value={sel.text || ''} onChange={(e) => patch(sel.id, { text: e.target.value })}
                         placeholder="text" style={{ ...btn, cursor: 'text', width: '100%', fontWeight: 400 }} />
                  <label style={{ fontSize: 11, color: muted, display: 'flex', alignItems: 'center', gap: 8 }}>
                    Colour <input type="color" value={sel.fill || '#ffffff'} onChange={(e) => patch(sel.id, { fill: e.target.value })} />
                    <input type="color" value={sel.stroke || '#111111'} onChange={(e) => patch(sel.id, { stroke: e.target.value })} /> outline
                  </label>
                </>
              )}
              <label style={{ fontSize: 11, color: muted }}>Size
                <input type="range" min={0.2} max={3} step={0.05} value={sel.scale} onChange={(e) => patch(sel.id, { scale: Number(e.target.value) })} style={{ width: '100%' }} />
              </label>
              <div style={{ fontSize: 10.5, color: muted }}>Drag the object on the canvas to reposition it.</div>
            </div>
          )}

          <div style={{ marginTop: 'auto', fontSize: 10.5, color: muted, lineHeight: 1.5 }}>
            Every layer stays editable — the exported SVG opens in Adobe Illustrator with this same layer list. The artist finalises the print file.
          </div>
        </div>
      </div>
    </div>
  );
}
