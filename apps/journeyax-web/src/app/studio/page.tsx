'use client';

/**
 * Studio — direct manipulation over the real render pipeline.
 *
 * The conversational surface and this one share ONE renderer. This page exists
 * because a dealer building a kit wants controls, not a conversation, and
 * because a deterministic surface is the only honest way to prove the pipeline:
 * pick a design line, pick colours, type a name — the garment changes, with no
 * agent in the loop to blame when it does not.
 *
 * Everything shown here is fetched, never hardcoded:
 *   design lines  -> the style's own catalogue entry
 *   colours       -> the brand's validated palette
 *   texture       -> Scene7, composed server-side
 *   mesh          -> the style's own glTF
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RosterPanel from '@/components/studio/RosterPanel';

interface DesignLine { slug: string; label: string; zones: string[] }
interface RenderResult {
  renderable?: boolean;
  texture?: string;
  geometry?: { glb: string; obj: string; normalMap?: string; format?: 'glb' | 'obj' };
  designLines?: DesignLine[];
  zones?: string[];
  rejectedColours?: string[];
  catalogueImage?: string;
  reason?: string;
}

const proxied = (url: string, project: string) =>
  `/api/products/asset?url=${encodeURIComponent(url)}&project=${encodeURIComponent(project)}`;

export default function StudioPage() {
  const [project, setProject] = useState('augusta');
  const [style, setStyle] = useState('329X3M');
  const [designLine, setDesignLine] = useState('serpentine');
  const [colours, setColours] = useState<string[]>(['RA WHITE', 'RA TRUE RED', 'RA ROYAL', 'RA BASEBALL GREY']);
  const [teamName, setTeamName] = useState('North View');
  const [number, setNumber] = useState('25');
  const [palette, setPalette] = useState<string[]>([]);
  const [sizeScale, setSizeScale] = useState<string[]>([]);
  const [tab, setTab] = useState<'design' | 'roster'>('design');
  const [data, setData] = useState<RenderResult>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [detail, setDetail] = useState('');
  const mountRef = useRef<HTMLDivElement | null>(null);

  // Read initial state from the URL so a design is shareable and a test is repeatable.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('project')) setProject(q.get('project')!);
    if (q.get('style')) setStyle(q.get('style')!);
    if (q.get('designLine')) setDesignLine(q.get('designLine')!);
    if (q.get('name')) setTeamName(q.get('name')!);
    if (q.get('number')) setNumber(q.get('number')!);
    if (q.get('colours')) setColours(q.get('colours')!.split(','));
  }, []);

  useEffect(() => {
    fetch(`/api/products/renderer-config?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((c: { palette?: string[]; sizeScale?: string[] }) => {
        setPalette(c?.palette || []);
        setSizeScale(c?.sizeScale || []);
      })
      .catch(() => { setPalette([]); setSizeScale([]); });
  }, [project]);

  const render = useCallback(async () => {
    setStatus('loading'); setDetail('');
    try {
      const res = await fetch(`/api/products/render?project=${encodeURIComponent(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style, designLine, colours,
          text: { teamName, number, numberSmall: number },
        }),
      });
      const d: RenderResult = await res.json();
      setData(d);
      if (!d.renderable || !d.texture) { setStatus('failed'); setDetail('This style has no live preview.'); }
    } catch {
      setStatus('failed'); setDetail('The preview service is not responding.');
    }
  }, [project, style, designLine, colours, teamName, number]);

  // Debounced so typing a name does not fire a server composite per keystroke.
  useEffect(() => { const t = setTimeout(render, 400); return () => clearTimeout(t); }, [render]);

  /* Scene: the style's own mesh wearing the composed atlas. */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !data.renderable || !data.texture || !data.geometry) return;

    let disposed = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const k = new THREE.DirectionalLight(0xffffff, 1.35); k.position.set(2, 3, 4);
    const f = new THREE.DirectionalLight(0xffffff, 0.55); f.position.set(-3, 1, -2);
    scene.add(k, f);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.enablePan = false;
    mount.appendChild(renderer.domElement);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);            // updateStyle ON: otherwise DPR doubles the CSS size
      camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(mount);
    let frame = 0;
    const loop = () => { frame = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();

    const loader = new THREE.TextureLoader();
    const tex = loader.load(proxied(data.texture, project), undefined, undefined,
      () => { if (!disposed) { setStatus('failed'); setDetail('The print could not be loaded.'); } });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    const normal = data.geometry.normalMap ? loader.load(data.geometry.normalMap) : null;
    if (normal) normal.flipY = false;

    const onLoaded = (root: THREE.Object3D) => {
      if (disposed) return;
      root.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = new THREE.MeshStandardMaterial({
          map: tex, normalMap: normal || undefined,
          roughness: 0.72, metalness: 0, side: THREE.DoubleSide,
        });
      });
      scene.add(root);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      root.position.sub(box.getCenter(new THREE.Vector3()));
      const vF = (camera.fov * Math.PI) / 180;
      const hF = 2 * Math.atan(Math.tan(vF / 2) * camera.aspect);
      const dist = Math.max((size.y / 2) / Math.tan(vF / 2),
                            (Math.max(size.x, size.z) / 2) / Math.tan(hF / 2)) * 1.3;
      camera.position.set(0, 0, dist);
      camera.near = dist / 100; camera.far = dist * 100; camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.minDistance = dist * 0.4; controls.maxDistance = dist * 2.5;
      controls.update();
      setStatus('ready');
    };
    const onErr = () => { if (!disposed) { setStatus('failed'); setDetail('The garment model could not be loaded.'); } };

    if (data.geometry.format === 'obj') new OBJLoader().load(data.geometry.obj, onLoaded, undefined, onErr);
    else new GLTFLoader().load(data.geometry.glb, (g) => onLoaded(g.scene), undefined, onErr);

    return () => {
      disposed = true; cancelAnimationFrame(frame); ro.disconnect();
      controls.dispose(); tex.dispose(); renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [data.texture, data.geometry?.glb, data.geometry?.format, data.renderable, project]);

  const lines = data.designLines || [];
  const zoneCount = data.zones?.length || 4;

  const S = {
    page: { display: 'flex', height: '100vh', background: '#0c0c0c', color: '#f2f2f2',
            fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 } as React.CSSProperties,
    stage: { flex: 1, position: 'relative', minWidth: 0,
             background: 'radial-gradient(ellipse at 50% 40%, #1a0a0a 0%, #0c0c0c 70%)' } as React.CSSProperties,
    side: { width: 268, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,.07)',
            overflowY: 'auto', background: '#141414', padding: 4 } as React.CSSProperties,
    sect: { padding: '14px 14px 12px', borderBottom: '1px solid rgba(255,255,255,.07)' } as React.CSSProperties,
    lbl: { fontSize: 9, fontWeight: 700, color: '#666', textTransform: 'uppercase',
           letterSpacing: '.09em', marginBottom: 10 } as React.CSSProperties,
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 } as React.CSSProperties,
    input: { width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid rgba(255,255,255,.12)',
             background: '#1c1c1c', color: '#f2f2f2', fontSize: 12, outline: 'none',
             fontFamily: 'inherit' } as React.CSSProperties,
  };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 8px', borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer',
    textAlign: 'center', transition: 'all .15s',
    border: `1px solid ${on ? '#e63329' : 'rgba(255,255,255,.07)'}`,
    background: on ? 'rgba(230,51,41,.12)' : '#1c1c1c', color: on ? '#e63329' : '#999',
  });

  const tabChip = (id: 'design' | 'roster', label: string): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${tab === id ? 'rgba(255,255,255,.14)' : 'transparent'}`,
    background: tab === id ? '#1c1c1c' : 'transparent',
    color: tab === id ? '#f2f2f2' : '#666',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh',
                  background: '#0c0c0c', color: '#f2f2f2',
                  fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 16px',
                    borderBottom: '1px solid rgba(255,255,255,.07)', flexShrink: 0 }}>
        <div style={tabChip('design', 'Design')} onClick={() => setTab('design')}>Design</div>
        <div style={tabChip('roster', 'Roster')} onClick={() => setTab('roster')}>Roster</div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: '#555' }}>
          {style}{teamName ? ` · ${teamName}` : ''}
        </span>
      </div>

    <div style={{ ...S.page, flex: 1, minHeight: 0, height: 'auto' }}>
      {/* The 3D context stays mounted across tabs: tearing down WebGL to show a
          table means rebuilding the scene every time the dealer switches back. */}
      <div style={{ ...S.stage, display: tab === 'design' ? 'block' : 'none' }}>
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
        {status !== 'ready' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        color: '#666', fontSize: 12, textAlign: 'center', padding: 24 }}>
            {status === 'loading' ? 'Rendering garment…' : status === 'failed' ? detail : ''}
          </div>
        )}
        <div style={{ position: 'absolute', left: 16, bottom: 14, fontSize: 10, letterSpacing: '.06em',
                      textTransform: 'uppercase', color: '#555' }}>
          {style} · {designLine} · {zoneCount} zones
        </div>
        <div style={{ position: 'absolute', right: 16, bottom: 14, fontSize: 10, letterSpacing: '.06em',
                      textTransform: 'uppercase', color: '#555' }}>
          {status === 'ready' ? 'Drag to turn · scroll to zoom' : ''}
        </div>
      </div>

      {/* The roster takes the whole working area — a 24-row table beside a
          jersey is neither readable nor useful. */}
      {tab === 'roster' && (
        <div style={{ flex: 1, minWidth: 0 }}>
          <RosterPanel
            project={project}
            garments={['jersey']}
            skuByGarment={style ? { jersey: style } : {}}
            sizeScale={sizeScale}
            teamName={teamName}
          />
        </div>
      )}

      <div style={{ ...S.side, display: tab === 'design' ? 'flex' : 'none', flexDirection: 'column' }}>
        <div style={S.sect}>
          <div style={S.lbl}>Style</div>
          <input style={S.input} value={style} onChange={(e) => setStyle(e.target.value.trim())} />
        </div>

        <div style={S.sect}>
          <div style={S.lbl}>Design line · {lines.length} on this style</div>
          <div style={S.grid}>
            {lines.map((d) => (
              <div key={d.slug} style={chip(d.slug === designLine)}
                   title={`${d.zones.length} colour zones`}
                   onClick={() => setDesignLine(d.slug)}>{d.label}</div>
            ))}
          </div>
          {!lines.length && <div style={{ fontSize: 11, color: '#555' }}>Loading…</div>}
        </div>

        {/* One swatch row per zone this design line actually exposes — not a
            fixed four. A design with no body zone simply has no body row. */}
        {(data.zones || []).map((zone, i) => (
          <div key={zone} style={S.sect}>
            <div style={S.lbl}>{zone.replace(/^SUB_(FIRST|SECOND)_/, '').replace(/_/g, ' ').toLowerCase()}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {palette.map((c) => (
                <div key={c} title={c}
                     onClick={() => setColours((prev) => { const n = [...prev]; n[i] = c; return n; })}
                     style={{ padding: '4px 7px', borderRadius: 5, fontSize: 10, cursor: 'pointer',
                              border: `1px solid ${colours[i] === c ? '#fff' : 'rgba(255,255,255,.1)'}`,
                              background: colours[i] === c ? 'rgba(230,51,41,.18)' : '#1c1c1c',
                              color: colours[i] === c ? '#fff' : '#888' }}>{c}</div>
              ))}
            </div>
          </div>
        ))}

        <div style={S.sect}>
          <div style={S.lbl}>Team name</div>
          <input style={S.input} value={teamName} onChange={(e) => setTeamName(e.target.value)} />
          <div style={{ ...S.lbl, marginTop: 12 }}>Number</div>
          <input style={S.input} value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} />
        </div>

        {!!data.rejectedColours?.length && (
          <div style={{ ...S.sect, color: '#f59e0b', fontSize: 11, lineHeight: 1.5 }}>
            {data.rejectedColours.join(', ')} not stocked by this brand — left off rather than substituted.
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
