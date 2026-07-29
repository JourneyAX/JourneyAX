'use client';

/**
 * Candy designer — the personalization step for M&M'S-style projects (MMS-01).
 *
 * Layout (customer-directed, from their mms.com research + mockup):
 *   • ONE scrolling screen, no step tracker.
 *   • A big LENTIL FIELD fills the top ~70%: flattened-ellipse candies in the
 *     chosen colours; the design (name/photo) rides on the larger lentils.
 *   • A slim RIGHT STRIP shows only the design preview + the 3 chosen colours.
 *   • Tapping ANY lentil opens a small pop-up ON it — colours, name, logo — for
 *     quick entry. That pop-up is where all editing happens.
 *   • Below the field: packaging, then price/checkout (Add to order → quote).
 *
 * Config-driven from `cfg.configurator` (shells + hex, text limit, fonts) so the
 * same panel serves any confectionery tenant. The print rules are enforced live
 * (the audit): 4 shells can't be printed on; text is 2 lines x 9 chars; an
 * uploaded photo is analysed for print feasibility before the order.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { useJourney } from '@/context/JourneyContext';
import { formatAUD } from '@/lib/types';

interface Shell { name: string; hex: string; printable: boolean }
interface Font { key: string; label: string; family: string; weight: number; style: string }

const YELLOW = 'var(--cfg-cta, #F5C800)';
const HEADFONT = "'Nunito', system-ui, 'Segoe UI', Arial, sans-serif";
const BROWN = 'var(--cfg-brown, #3D1C02)';
/** Round chips — width : height = 1 : 1, exactly like the customer's mockup. */
const LENTIL_RATIO = 1;

function clampByte(n: number) { return Math.max(0, Math.min(255, Math.round(n))); }
/** Lighten (pct > 0) or darken (pct < 0) a #rrggbb, the mms.com mockup's recipe. */
function shade(hex: string, pct: number): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return hex;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const f = pct / 100;
  const mix = (c: number) => pct >= 0 ? c + f * 255 : c * (1 + f);
  return `rgb(${clampByte(mix(r))}, ${clampByte(mix(g))}, ${clampByte(mix(b))})`;
}

/** True when a shell is light enough that black print reads better than white. */
function isLightShell(hex: string): boolean {
  const h = hex.replace('#', '');
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

/**
 * One glossy LENTIL — a flattened ellipse with a top-left radial highlight and
 * inset shadows (the recipe from the customer's mockup). Shows the "m" mark (a
 * plain letter, not a trademarked glyph) or the customer's design as children.
 */
function Candy({ hex, size, rot = 0, mark, onClick, children }: {
  hex: string; size: number; rot?: number; mark?: boolean; onClick?: () => void; children?: React.ReactNode;
}) {
  const h = Math.round(size * LENTIL_RATIO);
  const markColour = isLightShell(hex) ? 'rgba(40,32,28,.55)' : 'rgba(255,255,255,.9)';
  return (
    <div onClick={onClick}
      style={{ width: size, height: h, transform: `rotate(${rot}deg)`, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: '50%',
                    background: `radial-gradient(circle at 35% 30%, ${shade(hex, 30)}, ${hex} 50%, ${shade(hex, -20)})`,
                    boxShadow: '2px 5px 10px rgba(0,0,0,.28), inset -3px -5px 10px rgba(0,0,0,.24), inset 3px 4px 8px rgba(255,255,255,.34)' }}>
        {children}
        {mark && !children && (
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                         justifyContent: 'center', fontFamily: HEADFONT, fontWeight: 900,
                         fontSize: size * 0.4, lineHeight: 1, color: markColour,
                         textShadow: '0 1px 2px rgba(0,0,0,.2)', transform: `rotate(${-rot}deg)` }}>m</span>
        )}
      </div>
    </div>
  );
}

export default function CandyDesignPanel() {
  const cfg = useStorefrontConfig() as any;
  const { state, dispatch } = useJourney();
  const conf = cfg.configurator || {};
  const shells: Shell[] = Array.isArray(conf.shells) ? conf.shells : [];
  const fonts: Font[] = conf?.text?.fonts?.length ? conf.text.fonts : [
    { key: 'bold', label: 'Bold', family: 'Poppins, sans-serif', weight: 700, style: 'normal' },
  ];
  const maxChars: number = conf?.text?.maxChars || 9;
  const maxLines: number = conf?.text?.lines || 2;
  const maxColours: number = conf?.maxColours || 3;
  /* Clipart the candy can print (like mms.com's Icon tab) — so a themed brief
     ("unicorn party") lands an actual unicorn on the candy, not just a colour.
     Config-driven (`conf.icons`); the fallback is a broad party set. */
  const icons: { key: string; label: string; glyph: string }[] = Array.isArray(conf?.icons) && conf.icons.length ? conf.icons : [
    { key: 'unicorn', label: 'Unicorn', glyph: '🦄' }, { key: 'heart', label: 'Heart', glyph: '❤️' },
    { key: 'star', label: 'Star', glyph: '⭐' }, { key: 'rainbow', label: 'Rainbow', glyph: '🌈' },
    { key: 'cake', label: 'Cake', glyph: '🎂' }, { key: 'balloon', label: 'Balloon', glyph: '🎈' },
    { key: 'flower', label: 'Flower', glyph: '🌸' }, { key: 'butterfly', label: 'Butterfly', glyph: '🦋' },
    { key: 'crown', label: 'Crown', glyph: '👑' }, { key: 'party', label: 'Party', glyph: '🎉' },
  ];
  const design = state.design || {};
  const recommended: any[] = Array.isArray((state as any).recommendedProducts) ? (state as any).recommendedProducts : [];

  const [picked, setPicked] = useState<string[]>(() =>
    [design.baseColor, design.accentColor].filter(Boolean) as string[]);
  const [line1, setLine1] = useState(design.name || '');
  const [line2, setLine2] = useState(design.number || '');
  const [font, setFont] = useState<string>(fonts[0].key);
  const [photo, setPhoto] = useState<string | null>(design.artworkUrl || null);
  const [imgReport, setImgReport] = useState<{ level: 'warn' | 'info'; text: string }[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [icon, setIcon] = useState<string | null>((design as any).icon || null);
  const [packSku, setPackSku] = useState<string | null>(design.sku || null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const shellByName = useMemo(() => {
    const m: Record<string, Shell> = {};
    for (const s of shells) m[s.name.toLowerCase()] = s;
    return m;
  }, [shells]);

  const pickedShells = picked.map((n) => shellByName[n.toLowerCase()]).filter(Boolean);
  const printShell = pickedShells.find((s) => s.printable)
    || shells.find((s) => s.printable && /white/i.test(s.name))
    || shells.find((s) => s.printable)
    || { name: 'White', hex: '#F7F7F7', printable: true };
  const activeFont = fonts.find((f) => f.key === font) || fonts[0];

  const pileColours = useMemo(() => {
    const chosen = pickedShells.map((s) => s.hex);
    if (chosen.length) return chosen;
    const def = ['Red', 'Yellow', 'Blue', 'Green', 'Orange', 'Pink'];
    return def.map((n) => shellByName[n.toLowerCase()]?.hex).filter(Boolean) as string[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked.join('|')]);

  /* The lentil field — candies at %-positions that fill and slightly overflow
     the stage, the way the real configurator floods it. Deterministic
     (index-hashed) so it never reshuffles. The larger lentils carry the print. */
  const scatter = useMemo(() => {
    const hash = (n: number) => ((n * 2654435761) % 2147483647) / 2147483647;
    const pts: { xPct: number; yPct: number; rot: number }[] = [];
    const COLS = 7, ROWS = 6;   // dense grid of UNIFORM small chips (all one size)
    let i = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const jx = (hash(i * 7 + 1) - 0.5) * 12;
      const jy = (hash(i * 11 + 2) - 0.5) * 12;
      pts.push({
        xPct: ((c + 0.5) / COLS) * 100 + jx,
        yPct: ((r + 0.5) / ROWS) * 100 + jy,
        rot: Math.round((hash(i * 13 + 4) - 0.5) * 44),
      });
      i++;
    }
    return pts;
  }, []);
  /** Every chip is the SAME small size (customer: all lentils same size, tiny). */
  const CHIP = 74;

  function toggleShell(name: string) {
    setPicked((prev) => {
      if (prev.includes(name)) return prev.filter((n) => n !== name);
      if (prev.length >= maxColours) return [...prev.slice(1), name];
      return [...prev, name];
    });
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); setPhoto(url); auditImage(url); };
    reader.readAsDataURL(f);
  }

  /* THE IMAGE AUDIT (MMS-03) — print feasibility computed from the actual pixels
     (resolution, tonal range, background uniformity). Prints one colour, black,
     background removed. */
  function auditImage(url: string) {
    setImgReport([{ level: 'info', text: 'Checking your image the way our print team would…' }]);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const N = 120;
      const cv = document.createElement('canvas'); cv.width = N; cv.height = N;
      const ctx = cv.getContext('2d');
      if (!ctx) { setImgReport([]); return; }
      ctx.drawImage(img, 0, 0, N, N);
      let data: Uint8ClampedArray;
      try { data = ctx.getImageData(0, 0, N, N).data; } catch { setImgReport([]); return; }
      let hasAlpha = false, dark = 0, total = 0;
      const edge: number[] = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        const a = data[i + 3];
        if (a < 245) hasAlpha = true;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (a > 40) { total++; if (lum < 110) dark++; }
        if (x === 0 || y === 0 || x === N - 1 || y === N - 1) edge.push(lum);
      }
      const eMean = edge.reduce((s, v) => s + v, 0) / (edge.length || 1);
      const edgeStd = Math.sqrt(edge.reduce((s, v) => s + (v - eMean) ** 2, 0) / (edge.length || 1));
      const darkPct = total ? dark / total : 0;
      const rep: { level: 'warn' | 'info'; text: string }[] = [];
      if (Math.min(w, h) < 250) rep.push({ level: 'warn', text: `This image is ${w}×${h}px — small for print. At candy size (~1cm) it may look soft; a sharper photo prints cleaner.` });
      else rep.push({ level: 'info', text: `Resolution ${w}×${h}px — enough detail for a clean ~1cm print.` });
      if (darkPct < 0.06) rep.push({ level: 'warn', text: 'Your design is very light. It prints in solid black, so a pale image can almost vanish — a bolder, higher-contrast picture reads best.' });
      else rep.push({ level: 'info', text: 'Good contrast — there’s enough definition to read once it prints in black.' });
      if (hasAlpha) rep.push({ level: 'info', text: 'Transparent background — that lifts out cleanly, leaving just your subject.' });
      else if (edgeStd < 26) rep.push({ level: 'info', text: 'Plain background detected — we’ll remove it automatically so only your subject prints.' });
      else rep.push({ level: 'warn', text: 'Busy background — automatic background removal may leave stray marks. A photo on a plain wall cuts out best.' });
      rep.push({ level: 'info', text: 'Photos of people work great — keep it to one or two faces so each stays large enough to see.' });
      setImgReport(rep);
    };
    img.onerror = () => setImgReport([{ level: 'warn', text: 'Couldn’t read that image — try a JPG or PNG.' }]);
    img.src = url;
  }

  // ── Live print audit ─────────────────────────────────────────────
  const audit: { level: 'warn' | 'info'; text: string }[] = [];
  const nonPrintable = pickedShells.filter((s) => !s.printable);
  if (nonPrintable.length) audit.push({ level: 'warn', text:
    `${nonPrintable.map((s) => s.name).join(' and ')} can't be printed on — kept as an unprinted accent, with your text on ${printShell.name}.` });
  const over1 = line1.length > maxChars;
  const over2 = line2.length > maxChars;
  if (over1 || over2) audit.push({ level: 'warn', text:
    `Text is ${maxChars} characters per line. ${[over1 && `line 1 is ${line1.length}`, over2 && `line 2 is ${line2.length}`].filter(Boolean).join(', ')}.` });
  if (photo) audit.push(...imgReport);

  const muted = 'var(--text-muted,#888)';
  const canPrint = !over1 && !over2;
  const hasDesign = !!(line1 || line2 || photo || icon);
  const iconLabel = icon ? icons.find((i) => i.key === icon)?.label : undefined;

  /* The print that rides on a lentil face — a photo (clipped, printed black) or
     the two text lines, else nothing (the "m" shows). */
  function faceOf(sz: number): React.ReactNode {
    if (photo) return (
      <span style={{ position: 'absolute', inset: '20%', borderRadius: '50%', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover',
             filter: 'grayscale(1) contrast(1.7) brightness(0.72)' }} />
      </span>
    );
    const glyph = icon ? icons.find((i) => i.key === icon)?.glyph : null;
    if (glyph || line1 || line2) return (
      <span style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                     alignItems: 'center', justifyContent: 'center', lineHeight: 1.02,
                     fontFamily: activeFont.family, fontWeight: activeFont.weight, fontStyle: activeFont.style,
                     fontSize: sz * 0.15, color: '#201814', textAlign: 'center', padding: '0 12%' }}>
        {/* Clipart prints in black at candy size — shown dark to read as ink. */}
        {glyph && <span style={{ fontSize: sz * 0.34, lineHeight: 1, filter: 'grayscale(1) brightness(.35) contrast(1.4)' }}>{glyph}</span>}
        {line1 && <span>{line1.slice(0, maxChars)}</span>}
        {line2 && <span>{line2.slice(0, maxChars)}</span>}
      </span>
    );
    return null;
  }

  function addToOrder() {
    dispatch({ type: 'SET_DESIGN', design: {
      sku: packSku || design.sku,
      baseColor: printShell.name,
      accentColor: picked.find((n) => n.toLowerCase() !== printShell.name.toLowerCase()),
      name: line1.slice(0, maxChars),
      number: maxLines > 1 ? line2.slice(0, maxChars) : undefined,
      textColour: font,
      artworkUrl: photo || undefined,
      icon: icon || undefined,
    } as any });
    const send = (window as any).__journeySend;
    if (typeof send === 'function') {
      // Send the REAL catalogue SKU so the agent quotes THAT exact SKU. Without
      // it the model slugified the product NAME ("Tulip Party Favors" →
      // TULIP-PARTY-FAVORS), which the pricebook (keyed by metadata.sku, e.g.
      // CT2234) can't resolve → "Price on request". Naming the SKU and telling
      // it not to substitute makes updateQuote price the line for real.
      const sku = packSku || design.sku;
      const packName = recommended.find((p) => p.sku === packSku)?.name;
      send(`I've personalised this: ${picked.join(', ') || printShell.name} shells`
        + `${iconLabel ? `, with a ${iconLabel} clipart design` : ''}`
        + `${line1 ? `, printing "${line1}${line2 ? ' / ' + line2 : ''}"` : ''}`
        + `${photo ? ', with my photo' : ''}${packName ? `, packaged as ${packName}` : ''}.`
        + `${sku ? ` Build my quote for SKU ${sku} — call updateQuote with sku "${sku}" exactly, do NOT substitute or rename it.` : ' Build my quote.'}`);
    }
  }

  // Prices are stored in DOLLARS (like the rest of the app — formatAUD never
  // divides by 100). The old `/100` here turned a $65 gift box into "$0.65".
  const priceOf = (p: any) => formatAUD(typeof p.price === 'number' ? p.price : undefined);
  const sectionLabel: React.CSSProperties = { fontFamily: HEADFONT, fontWeight: 900, fontSize: 18, color: BROWN, marginBottom: 4 };

  return (
    <div style={{ position: 'relative', height: '100%', overflowY: 'auto', boxSizing: 'border-box', padding: '18px 22px 22px' }}>
      {/* Header */}
      <div style={{ paddingBottom: 10, marginBottom: 12, borderBottom: '1px solid var(--border,#eee)' }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: BROWN, fontFamily: HEADFONT }}>
          {conf.title || 'Design your candy'}
        </div>
        {design.sku && <div style={{ fontSize: 11.5, color: muted, marginTop: 3 }}>SKU {design.sku}</div>}
      </div>

      {/* DESIGN AREA — the lentil field fills the WHOLE panel width. EVERY chip
          is the same small size; when a design is set each chip carries it (like
          a real bag), else each shows "m". Tapping ANYWHERE opens the pop-up. */}
      <div onClick={() => setEditorOpen(true)}
        style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', cursor: 'pointer',
                 minHeight: '58vh', background: 'var(--stage-bg,#F0EFE8)' }}>
        {scatter.map((p, i) => (
          <div key={i} style={{ position: 'absolute', left: `${p.xPct}%`, top: `${p.yPct}%`, transform: 'translate(-50%, -50%)' }}>
            <Candy hex={pileColours[i % pileColours.length]} size={CHIP} rot={p.rot} mark={!hasDesign}>
              {hasDesign ? faceOf(CHIP) : undefined}
            </Candy>
          </div>
        ))}
        <div style={{ position: 'absolute', left: 14, bottom: 12, zIndex: 5, fontSize: 11.5, fontWeight: 700,
                      color: BROWN, background: 'rgba(255,255,255,.85)', padding: '5px 11px', borderRadius: 20,
                      pointerEvents: 'none' }}>
          Tap anywhere to design ✎
        </div>
      </div>

      {/* PACKAGING — same scrolling screen, below the field. */}
      <div style={{ marginTop: 26 }}>
        <div style={sectionLabel}>Pick your packaging</div>
        <div style={{ fontSize: 12, color: muted, marginBottom: 12 }}>Choose how your candies are presented.</div>
        {recommended.length ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {recommended.map((p) => (
              <button key={p.sku} type="button" onClick={() => setPackSku(p.sku)}
                style={{ textAlign: 'left', padding: '11px 13px', borderRadius: 12, cursor: 'pointer',
                         background: packSku === p.sku ? 'var(--surface-2,#f4f4f4)' : 'var(--surface,#fff)',
                         border: `1.5px solid ${packSku === p.sku ? 'var(--primary,#2D7A2D)' : 'var(--border,#e6e6e6)'}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{p.name}</div>
                <div style={{ fontSize: 12.5, color: muted, marginTop: 3 }}>{priceOf(p)}</div>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: muted, lineHeight: 1.5 }}>I&apos;ll suggest packaging in the chat — your design is ready to quote.</div>
        )}
      </div>

      {/* CHECKOUT — price + quote handoff. */}
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border,#eee)',
                    display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <button type="button" onClick={addToOrder} disabled={!canPrint}
          style={{ padding: '12px 24px', borderRadius: 26, border: 'none', fontSize: 14, fontWeight: 900, fontFamily: HEADFONT,
                   cursor: canPrint ? 'pointer' : 'not-allowed', opacity: canPrint ? 1 : 0.5,
                   background: YELLOW, color: BROWN }}>
          Add to order &amp; get a quote →
        </button>
        <span style={{ fontSize: 11.5, color: muted }}>
          {conf.logoRule || 'Business logos print in black at candy size.'}
        </span>
      </div>

      {/* THE LENTIL POP-UP — colours, name, logo. Opened by tapping a lentil. */}
      {editorOpen && (
        <div onClick={() => setEditorOpen(false)}
          style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(20,16,14,.45)',
                   display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, maxHeight: '94%', overflowY: 'auto', background: 'var(--surface,#fff)',
                     borderRadius: 16, boxShadow: '0 12px 40px rgba(0,0,0,.3)', padding: 18,
                     display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontFamily: HEADFONT, fontWeight: 900, fontSize: 17, color: BROWN }}>Design your lentil</div>
              <button type="button" onClick={() => setEditorOpen(false)}
                style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: muted, lineHeight: 1 }}>
                &times;
              </button>
            </div>

            {/* Colours */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>
                Colours — up to {maxColours} ({picked.length} chosen)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {shells.map((s) => {
                  const on = picked.includes(s.name);
                  return (
                    <button key={s.name} type="button" onClick={() => toggleShell(s.name)}
                      title={`${s.name}${s.printable ? '' : ' · not printable'}`}
                      style={{ width: 30, height: 30, borderRadius: '50%', background: s.hex, cursor: 'pointer',
                               border: on ? '3px solid #111' : '1px solid rgba(0,0,0,.2)', position: 'relative', outline: 'none' }}>
                      {!s.printable && (
                        <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', overflow: 'hidden' }}>
                          <span style={{ position: 'absolute', top: '48%', left: '-4%', width: '108%', height: 2,
                                         background: '#fff', boxShadow: '0 0 1px #000', transform: 'rotate(-45deg)' }} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>We don’t print on {nonPrintableNames(shells)}.</div>
            </div>

            {/* Clipart / icon — so a themed brief (e.g. "unicorn party") can put
                an actual unicorn on the candy, printed in black at candy size. */}
            {icons.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>
                  Clipart {icon ? '· 1 chosen' : '(optional)'}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {icons.map((ic) => {
                    const on = icon === ic.key;
                    return (
                      <button key={ic.key} type="button" title={ic.label}
                        onClick={() => setIcon(on ? null : ic.key)}
                        style={{ width: 38, height: 38, borderRadius: 9, cursor: 'pointer', fontSize: 20, lineHeight: 1,
                                 background: on ? 'var(--surface-2,#f4f4f4)' : 'var(--surface,#fff)',
                                 border: `2px solid ${on ? 'var(--primary,#2D7A2D)' : 'var(--border,#e0e0e0)'}` }}>
                        {ic.glyph}
                      </button>
                    );
                  })}
                </div>
                {icon && <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>{iconLabel} prints in black at candy size. Tap again to remove.</div>}
              </div>
            )}

            {/* Name */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>
                Name / message — {maxLines} lines, {maxChars} each
              </div>
              <input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Line 1" maxLength={maxChars + 4}
                style={{ width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 8, boxSizing: 'border-box',
                         border: `1px solid ${over1 ? 'var(--warning,#c0392b)' : 'var(--border,#ddd)'}` }} />
              {maxLines > 1 && (
                <input value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Line 2 (optional)" maxLength={maxChars + 4}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 8, boxSizing: 'border-box',
                           border: `1px solid ${over2 ? 'var(--warning,#c0392b)' : 'var(--border,#ddd)'}` }} />
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {fonts.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFont(f.key)}
                    style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
                             fontFamily: f.family, fontStyle: f.style, fontWeight: f.weight,
                             background: font === f.key ? 'var(--primary,#2D7A2D)' : 'transparent',
                             color: font === f.key ? '#fff' : 'var(--text)',
                             border: `1px solid ${font === f.key ? 'var(--primary,#2D7A2D)' : 'var(--border,#ddd)'}` }}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Logo / photo */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>
                Logo or photo
              </div>
              <input ref={fileRef} type="file" accept="image/*" onChange={onUpload} style={{ display: 'none' }} />
              <button type="button" onClick={() => fileRef.current?.click()}
                style={{ padding: '9px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                         background: 'transparent', color: 'var(--text)', border: '1px solid var(--border,#ddd)' }}>
                {photo ? 'Change logo / photo' : 'Upload a logo or photo'}
              </button>
              {photo && (
                <button type="button" onClick={() => { setPhoto(null); setImgReport([]); }}
                  style={{ marginLeft: 8, padding: '9px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                           background: 'transparent', color: muted, border: '1px solid var(--border,#ddd)' }}>
                  Remove
                </button>
              )}
            </div>

            {audit.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {audit.map((a, i) => (
                  <p key={i} style={{ fontSize: 11.5, lineHeight: 1.45, margin: 0,
                                      color: a.level === 'warn' ? 'var(--warning,#c0392b)' : 'var(--text-secondary,#666)' }}>
                    {a.level === 'warn' ? '⚠ ' : 'ℹ '}{a.text}
                  </p>
                ))}
              </div>
            )}

            <button type="button" onClick={() => setEditorOpen(false)}
              style={{ padding: '11px 20px', borderRadius: 24, border: 'none', fontSize: 13.5, fontWeight: 900, fontFamily: HEADFONT,
                       cursor: 'pointer', background: YELLOW, color: BROWN }}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The names of the shells that can't be printed on, for the pop-up note. */
function nonPrintableNames(shells: Shell[]): string {
  const names = shells.filter((s) => !s.printable).map((s) => s.name.toLowerCase());
  if (!names.length) return 'certain dark colours';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
