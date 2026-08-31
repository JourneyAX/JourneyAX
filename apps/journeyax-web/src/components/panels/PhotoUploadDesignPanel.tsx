'use client';

/**
 * PhotoUploadDesignPanel — REAL PHOTOS of an actual garment, baked onto the
 * real 3D mesh.
 *
 * This is a separate, honest flow from TeamDesignPanel: TeamDesignPanel's four
 * views are AI-GENERATED from a text brief. Here the customer uploads up to four
 * PHOTOGRAPHS they took themselves (front required; back/left sleeve/right
 * sleeve optional) of a garment they already have, and we send those exact
 * bytes to POST /api/cdl/bake3d, which paints each view onto the style's real
 * 3D UV atlas (Python retexture-service) and returns a `glbUrl` we load
 * directly — no AI generation step, no invented artwork.
 *
 * Honest scope: this proves "does your real garment look right wrapped onto our
 * mesh in 3D" — it does not produce production cut-piece files, and we never
 * claim it does.
 *
 * The 3D viewer here is a deliberately MINIMAL "load this one GLB and let the
 * customer orbit it" component, not a reuse of CustomDesign3D — CustomDesign3D
 * owns its own decompose→decal→roster pipeline and always drives its OWN bake
 * fetch from a stored design handle (sourceId), it has no "just show me a GLB
 * I already baked" entry point. Duplicating its lighting/tone-mapping constants
 * would be worse than this ~40-line viewer, so that's the one piece rebuilt
 * here; everything else (upload UI, bake call) is new since no prior art exists
 * for a raw-photo upload flow.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

type SlotKey = 'front' | 'back' | 'left' | 'right';
const SLOTS: { key: SlotKey; label: string; required?: boolean }[] = [
  { key: 'front', label: 'Front', required: true },
  { key: 'back', label: 'Back' },
  { key: 'left', label: 'Left sleeve' },
  { key: 'right', label: 'Right sleeve' },
];

/** Same pattern as ChatPanel's readImageFile — a FileReader → data URL promise,
 *  reused here instead of reinvented since it's exactly what the bake endpoint
 *  wants for `front`/`back`/`left`/`right` (a data: URL or bare base64). */
function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('That file is not an image.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

interface SlotState { dataUrl: string; name: string }

/** Minimal "load one GLB, let the customer orbit it" viewer — the flat part of
 *  CustomDesign3D's scene setup, without decompose/decals/roster since this
 *  flow never needs them (the design is already baked server-side by the time
 *  this mounts). */
function BakedGlbViewer({ glbUrl }: { glbUrl: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    if (!mountRef.current || !glbUrl) return;
    let disposed = false;
    let raf = 0;
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const key1 = new THREE.DirectionalLight(0xffffff, 1.1); key1.position.set(1, 1.4, 2); scene.add(key1);
    const key2 = new THREE.DirectionalLight(0xffffff, 0.6); key2.position.set(-1.2, 0.5, -1.5); scene.add(key2);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4); fill.position.set(0, -1, 1); scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    mount.appendChild(renderer.domElement);

    const resize = () => {
      const w = mount.clientWidth || 1, h = mount.clientHeight || 1;
      renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(mount);
    const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();

    new GLTFLoader().load(
      glbUrl,
      (gltf) => {
        if (disposed) return;
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        scene.add(root);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        root.position.sub(centre);
        const span = Math.max(size.x, size.y, size.z) || 1;
        const dist = span * 1.7;
        camera.position.set(0, 0, dist);
        camera.near = dist / 100; camera.far = dist * 100; camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.minDistance = dist * 0.5; controls.maxDistance = dist * 2.2; controls.update();
        setStatus('ready');
      },
      undefined,
      () => { if (!disposed) setStatus('failed'); },
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [glbUrl]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 320 }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
      {status !== 'ready' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
          {status === 'failed' ? '⚠ Could not load the 3D preview.' : 'Loading your 3D garment…'}
        </div>
      )}
    </div>
  );
}

export default function PhotoUploadDesignPanel() {
  const { state } = useJourney();
  const cfg = useStorefrontConfig() as any;
  const project = cfg?.projectId
    || (typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('project') || '');
  const sku = state.design?.sku;

  const [slots, setSlots] = useState<Partial<Record<SlotKey, SlotState>>>({});
  const [baking, setBaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ glbUrl: string } | null>(null);
  const [dragOver, setDragOver] = useState<SlotKey | null>(null);
  const inputRefs = useRef<Partial<Record<SlotKey, HTMLInputElement | null>>>({});

  const setFile = useCallback(async (key: SlotKey, file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readImageFile(file);
      setSlots((prev) => ({ ...prev, [key]: { dataUrl, name: file.name || key } }));
    } catch (e: any) {
      setError(e?.message || `Couldn't read that ${key} photo — try a different image file.`);
    }
  }, []);

  const clearSlot = (key: SlotKey) => {
    setSlots((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setResult(null);
  };

  const canGenerate = !!slots.front && !baking;

  const generate = async () => {
    if (!slots.front) return;
    if (!sku) {
      setError("We don't know which style to match your photos to yet — tell the agent which garment/style this is first.");
      return;
    }
    setBaking(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/cdl/bake3d${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': project || 'augusta' },
        body: JSON.stringify({
          sku,
          front: slots.front.dataUrl,
          ...(slots.back ? { back: slots.back.dataUrl } : {}),
          ...(slots.left ? { left: slots.left.dataUrl } : {}),
          ...(slots.right ? { right: slots.right.dataUrl } : {}),
          tier: 'quality',
          size: 2048,
        }),
      });
      const j = await res.json().catch(() => ({ ok: false }));
      if (!j?.ok || !j?.glbUrl) {
        setError(j?.message || "Couldn't process those photos — try a clearer, front-facing photo of the garment laid flat or on a hanger, with good lighting.");
        return;
      }
      setResult({ glbUrl: j.glbUrl });
    } catch (e: any) {
      setError(`Couldn't reach the 3D bake service (${e?.message || 'network error'}) — try again in a moment.`);
    } finally {
      setBaking(false);
    }
  };

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Real-photo 3D match</div>
          <h2 className="clarify-panel__heading">Upload real photos of your garment</h2>
          <p className="clarify-panel__desc">
            Take photos of the actual garment you want to match — front is required; back and both sleeves are
            optional but help the wrap look more accurate. We paint your exact photos onto the real 3D mesh, so
            you can see your garment rendered in 3D. This is not an AI-generated design and it does not produce
            production-ready cut-piece files — it's a real-photo 3D preview.
          </p>

          {!sku && (
            <div style={{ fontSize: 12.5, color: '#a15c00', marginBottom: 16, padding: '10px 14px',
                          borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(161,92,0,0.08)' }}>
              No style selected yet — mention which garment/style this is in chat before generating.
            </div>
          )}

          {!result && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {SLOTS.map((s) => {
                const slot = slots[s.key];
                const isOver = dragOver === s.key;
                return (
                  <div key={s.key} className="product-card" style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
                                  color: 'var(--text-muted)', padding: '10px 12px 0', display: 'flex',
                                  justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{s.label}{s.required ? ' *' : ''}</span>
                      {slot && (
                        <button
                          type="button"
                          onClick={() => clearSlot(s.key)}
                          aria-label={`Remove ${s.label} photo`}
                          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)',
                                   cursor: 'pointer', fontSize: 13 }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => inputRefs.current[s.key]?.click()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRefs.current[s.key]?.click(); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(null);
                        setFile(s.key, e.dataTransfer?.files?.[0]);
                      }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(s.key); }}
                      onDragLeave={() => setDragOver((cur) => (cur === s.key ? null : cur))}
                      style={{
                        aspectRatio: '1 / 1', margin: 10, borderRadius: 8, overflow: 'hidden',
                        background: 'var(--surface-alt)', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', cursor: 'pointer',
                        border: isOver ? '2px dashed var(--text)' : '1px dashed var(--border)',
                      }}
                    >
                      {slot ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={slot.dataUrl} alt={`${s.label} photo`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : (
                        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', textAlign: 'center', padding: 12 }}>
                          Click or drag a photo here
                        </span>
                      )}
                    </div>
                    <input
                      ref={(el) => { inputRefs.current[s.key] = el; }}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => { setFile(s.key, e.target.files?.[0]); e.target.value = ''; }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {baking && (
            <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-muted)', display: 'flex',
                          alignItems: 'center', gap: 8 }}>
              <span className="cd3d-spin" style={{ display: 'inline-block' }}>◔</span>
              Baking your 3D preview… this can take a minute or two — we're wrapping your real photos onto the
              garment's 3D mesh.
            </div>
          )}

          {error && (
            <div style={{ marginTop: 18, fontSize: 12.5, color: '#b00020', padding: '10px 14px',
                          borderRadius: 8, border: '1px solid rgba(176,0,32,0.25)', background: 'rgba(176,0,32,0.06)' }}>
              {error}
            </div>
          )}

          {result && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
                            color: 'var(--text-muted)', marginBottom: 8 }}>
                Your garment, baked in 3D · drag to rotate
              </div>
              <div style={{ height: 360, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <BakedGlbViewer glbUrl={result.glbUrl} />
              </div>
            </div>
          )}
          <style>{`@keyframes cd3dspin{to{transform:rotate(360deg)}}.cd3d-spin{animation:cd3dspin 1s linear infinite}`}</style>
        </div>
      </div>

      <div className="clarify-panel__footer" style={{ display: 'flex', gap: 10 }}>
        {result ? (
          <button
            className="clarify-build-btn"
            style={{ flex: 1, background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}
            onClick={() => { setResult(null); setError(null); }}
          >
            Try different photos
          </button>
        ) : (
          <button className="clarify-build-btn" style={{ flex: 1 }} disabled={!canGenerate} onClick={generate}>
            {baking ? 'Baking your 3D preview…' : 'Generate 3D Preview'}
          </button>
        )}
      </div>
    </div>
  );
}
