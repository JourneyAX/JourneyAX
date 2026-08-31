'use client';

/**
 * CustomDesign3D — the customer's OWN design, on the real garment mesh, editable.
 *
 * This is "Job 2": take the uploaded/generated design, split it into a tileable
 * all-over PATTERN and a clean LOGO (the /cdl/decompose step), then:
 *   • wrap the pattern across the style's real 3D mesh (the same GLB/OBJ the
 *     normal configurator loads), and
 *   • drop the logo, team name and number onto the garment SURFACE as projected
 *     decals the customer can DRAG, resize and recolour — right on the jersey,
 *     inside safe zones, not floating on a flat canvas.
 *
 * It owns its own Three.js scene so the 1,100-line parametric ConfiguratorPanel
 * stays untouched. The fabric fidelity (how clean the pattern/logo are) is the
 * separate "Job 1" — today Gemini via /cdl/decompose, later a higher-fidelity
 * model — but the viewer/editor below is agnostic to which produced them.
 *
 * Honest scope: the pattern is tiled in UV space (truthful all-over sublimation),
 * NOT a pixel-copy of the flat proof. The logo/number/name are real, movable,
 * printable placements. Cut-piece export is a later step.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';

export interface CustomDesign3DProps {
  /** The renderable style whose mesh we paint the design onto. */
  sku: string;
  /** The design image handle (conceptId or proofId) to decompose into layers. */
  sourceId: string;
  /** Optional raw design URL (http or data:) used INSTEAD of sourceId for the
   *  bake — for a design that arrives as bytes rather than a stored handle. */
  frontUrl?: string;
  project: string;
  /** Pre-filled from the design analysis. */
  teamName?: string;
  number?: string;
  /** Colour NAMES for the parametric render (body, accent, …). Drives the real
   *  Scene7 atlas so the garment shows the customer's colours on real zones. */
  colours?: string[];
  /** The matched design-line (stripe/pattern style); the render defaults to the
   *  widest one when absent, which still shows real structure. */
  designLine?: string;
  /** Extracted palette (name + hex) — the recolour swatches. */
  palette?: { name: string; hex: string; role?: string }[];
  /** Team roster (AUG-32) — per-player name + number. When present, the baked
   *  garment is a shared pattern and each player's name/number is overlaid on the
   *  back as a decal: ONE bake dresses the whole squad (no per-player re-bake). */
  roster?: { name?: string; number?: string }[];
  /** Notified when the customer edits, so the panel can enable "looks right → review". */
  onEdited?: () => void;
}

const conceptUrl = (id: string, project: string) =>
  `/api/cdl/concept/${encodeURIComponent(id)}${project ? `?project=${encodeURIComponent(project)}` : ''}`;
const proxied = (url: string, project: string) =>
  `/api/products/asset?url=${encodeURIComponent(url)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;

/** Draw text to a transparent canvas → a texture we can project as a decal.
 *  The canvas matches the decal's `aspect` and the font shrinks to fit, so a
 *  long name ("SVENSSON") is never clipped the way a fixed square canvas clipped
 *  it — while a 1–2 digit number still fills a square. */
function textTexture(text: string, colour: string, outline: string, aspect = 1): THREE.CanvasTexture {
  const h = 512;
  const w = Math.max(64, Math.round(h * aspect));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let font = Math.round(h * 0.62);
  ctx.font = `900 ${font}px Arial, sans-serif`;
  const maxW = w * 0.9;
  while (font > 24 && ctx.measureText(text).width > maxW) {
    font -= 8;
    ctx.font = `900 ${font}px Arial, sans-serif`;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(8, font * 0.09);
  ctx.strokeStyle = outline;
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = colour;
  ctx.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Load an image and make its (near-uniform) background transparent, so a logo
 *  sits on the fabric instead of inside an opaque box. Samples the four corners
 *  for the background colour and clears pixels within a tolerance of it. */
function loadKnockedOut(url: string): Promise<THREE.CanvasTexture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      const p = data.data;
      // Background = average of the four corners.
      const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
      let br = 0, bg = 0, bb = 0;
      for (const i of corners) { br += p[i]; bg += p[i + 1]; bb += p[i + 2]; }
      br /= 4; bg /= 4; bb /= 4;
      const tol = 60; // colour distance under which a pixel counts as background
      for (let i = 0; i < p.length; i += 4) {
        const d = Math.abs(p[i] - br) + Math.abs(p[i + 1] - bg) + Math.abs(p[i + 2] - bb);
        if (d < tol) p[i + 3] = 0;                       // fully transparent
        else if (d < tol * 2) p[i + 3] = Math.round((d - tol) / tol * 255); // feathered edge
      }
      ctx.putImageData(data, 0, 0);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      resolve(t);
    };
    img.onerror = reject;
    img.src = url;
  });
}

type DecalKind = 'logo' | 'number' | 'name';
interface DecalDef {
  kind: DecalKind;
  texture: THREE.Texture;
  size: number;          // world-units box size
  aspect: number;        // width/height of the art
  /** Anchor as a fraction of the mesh bounding box: x in [0,1] (0 left),
   *  y in [0,1] (0 bottom), and which face (front/back). */
  fx: number; fy: number; face: 'front' | 'back';
  mesh?: THREE.Mesh;     // the live decal mesh in the scene
}

/** Diagnostics the bake returns — the design DATA we surface in the panel. */
interface BakeDiag {
  atlas?: string;
  coverage?: number;
  verdict?: 'good' | 'usable' | 'poor' | 'unknown';
  views?: { view: string; iou: number; locked: boolean }[];
  palette?: { rgb: number[]; hex: string; share: number }[];
  mesh?: { tris: number; verts: number };
  warnings?: string[];
}

export default function CustomDesign3D(props: CustomDesign3DProps) {
  const { sku, sourceId, project } = props;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [step, setStep] = useState('Loading the garment…');
  const [selected, setSelected] = useState<DecalKind | null>(null);
  const [number, setNumber] = useState(props.number || '');
  const [name, setName] = useState(props.teamName || '');
  /** 'baked' = design wrapped into the mesh's UV atlas (retexture-service, faithful);
   *  'flat'  = fallback GPT-image planar projection when the bake is unavailable. */
  const [mode, setMode] = useState<'baked' | 'flat'>('flat');
  /** The bake's design data — palette+hex, coverage, per-view IoU, verdict. */
  const [diag, setDiag] = useState<BakeDiag | null>(null);
  const [showData, setShowData] = useState(true);
  /** Which roster player's name/number is shown on the back (baked mode). */
  const roster = props.roster && props.roster.length ? props.roster : null;
  const [playerIdx, setPlayerIdx] = useState(0);

  // Live scene handles the editor UI reaches into without a React re-render.
  const sceneApi = useRef<{
    garment?: THREE.Mesh;
    decals: DecalDef[];
    scene?: THREE.Scene;
    redrawDecal: (d: DecalDef) => void;
    baseMaterial?: THREE.MeshStandardMaterial;
    /** Baked mode: repaint the back name/number decals for the current player. */
    setBackText?: (name: string, number: string) => void;
    /** The back NAME rendered as one small decal PER LETTER (a single wide decal
     *  clips on the curved back). Tracked so a name change disposes the old set. */
    nameLetters?: THREE.Mesh[];
  }>({ decals: [], redrawDecal: () => {} });

  /* Build once per (sku, sourceId): fetch mesh + decomposed layers, assemble the
     scene, wire orbit + decal dragging. Guarded so React StrictMode's double
     mount doesn't build two WebGL contexts. */
  const builtFor = useRef('');
  useEffect(() => {
    const key = `${sku}::${sourceId}`;
    if (!mountRef.current || builtFor.current === key) return;
    builtFor.current = key;

    let disposed = false;
    let raf = 0;
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Photographic tonemapping so the colours read like fabric, not flat sprite.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    const scene = new THREE.Scene();
    sceneApi.current.scene = scene;
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

    const fail = (msg: string) => { if (!disposed) { setStatus('failed'); setStep(msg); } };

    /* Centre the mesh at the origin and pull the camera back to frame it. Shared
       by the baked and the flat-fallback paths. */
    const frameAndAdd = (root: THREE.Object3D) => {
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
    };

    (async () => {
      // 1 — the real mesh AND the factory's parametric atlas for this style, in
      // the customer's colours. This is the SAME render the normal configurator
      // uses: the atlas is correctly UV-mapped (front/back/sleeves), crisp, and
      // carries real colour zones + stripe design-lines + collar. We render onto
      // THAT instead of tiling a flat raster (which destroyed all structure).
      setStep('Rendering the garment in your colours…');
      const rres = await fetch(`/api/products/render${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          style: sku,
          colours: props.colours || [],
          designLine: props.designLine,
        }),
      }).then((r) => r.json()).catch(() => null);
      const geo = rres?.geometry;
      if (!geo || (!geo.obj && !geo.glb)) return fail('This style has no 3D model to place the design on.');

      // 1b — the FAITHFUL BAKED path (P3): ask the retexture-service to wrap the
      // customer's design INTO the mesh's UV atlas — front painted from the
      // design, back continuing the pattern with the team name/number. The
      // returned GLB already carries the design in its own material, so we load
      // it as-is (no planar projection, no decals) and it wraps collar, hem and
      // sleeves correctly. On any failure we fall through to the flat path below.
      setStep('Baking your design onto the real jersey… (this takes a moment)');
      // With a roster, bake a PATTERN-ONLY back (paintBack) and overlay each
      // player's name/number as a decal; otherwise bake the single garment's
      // name/number into the back.
      const rosterMode = !!roster;
      const backText = rosterMode ? undefined
        : ([props.teamName, props.number].filter(Boolean).join('\n') || undefined);
      const bake = await fetch(`/api/cdl/bake3d${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': project || 'augusta' },
        body: JSON.stringify({
          sku, glbUrl: geo.glb, backText, paintBack: rosterMode, tier: 'quality', size: 2048,
          ...(props.frontUrl ? { front: props.frontUrl } : { frontSourceId: sourceId }),
        }),
      }).then((r) => r.json()).catch(() => null);
      if (disposed) return;
      if (bake?.ok && bake.glbUrl) {
        setStep('Loading your 3D garment…');
        const g: any = await new Promise((res, rej) =>
          new GLTFLoader().load(bake.glbUrl, res, undefined, rej)).catch(() => null);
        if (disposed) return;
        if (g?.scene) {
          const root: THREE.Object3D = g.scene;   // materials already carry the baked design
          root.updateMatrixWorld(true);
          let garment: THREE.Mesh | undefined;
          root.traverse((child) => { const m = child as THREE.Mesh; if (m.isMesh && !garment) garment = m; });
          sceneApi.current.garment = garment;
          sceneApi.current.decals = [];            // pattern is baked into the atlas
          frameAndAdd(root);

          // Roster overlay: the back is pattern-only, so drop the current player's
          // NAME (upper back) and NUMBER (centre back) on as surface decals. ONE
          // bake serves the whole squad — flipping players just repaints these.
          const initName = (roster ? roster[0]?.name : props.teamName) || '';
          const initNo = (roster ? roster[0]?.number : props.number) || '';
          if (initName || initNo || roster) {
            // NUMBER: a single centred decal on the mid back (square, projects clean).
            const numDecal: DecalDef = {
              kind: 'number', texture: textTexture(initNo || ' ', '#fff', '#111', 1),
              size: 0.4, aspect: 1, fx: 0.5, fy: 0.44, face: 'back',
            };
            sceneApi.current.decals = [numDecal];
            sceneApi.current.redrawDecal(numDecal);

            // NAME: one small decal PER LETTER. A single wide decal box only grips
            // the curved back at its centre, clipping the ends ("CARTER" → "RTI");
            // small per-letter boxes each project cleanly. Laid out across the
            // torso back (a narrow span so letters stay off the spread sleeves)
            // and auto-sized to the name length so any name fits.
            sceneApi.current.nameLetters = [];
            const buildName = (nm: string) => {
              for (const m of sceneApi.current.nameLetters || []) {
                (m.geometry as THREE.BufferGeometry).dispose();
                scene.remove(m);
              }
              sceneApi.current.nameLetters = [];
              const g = sceneApi.current.garment;
              if (!g) return;
              const chars = (nm || '').toUpperCase().split('');
              const L = chars.length;
              if (!L) return;
              const span = 0.3;                 // name spans ~30% of width, centred (torso, not sleeves)
              const fxStep = span / L;
              g.updateWorldMatrix(true, false);
              const bx = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
              const letterSize = Math.min(0.16, fxStep * bx.x * 0.92);
              chars.forEach((ch, i) => {
                if (ch === ' ') return;
                // On the BACK, higher fx maps to screen-LEFT, so the first letter
                // must sit at the HIGHEST fx for the name to read left-to-right
                // (otherwise "CARTER" comes out "RETRAC"). Hence ((L-1)/2 - i).
                const fx = 0.5 + ((L - 1) / 2 - i) * fxStep;
                const d: DecalDef = {
                  kind: 'name', texture: textTexture(ch, '#fff', '#111', 0.72),
                  size: letterSize, aspect: 0.72, fx, fy: 0.68, face: 'back',
                };
                sceneApi.current.redrawDecal(d);
                if (d.mesh) sceneApi.current.nameLetters!.push(d.mesh);
              });
            };
            buildName(initName);

            // Expose an updater the roster selector / edit inputs call to reprint.
            sceneApi.current.setBackText = (nm: string, no: string) => {
              buildName(nm);
              numDecal.texture = textTexture(no || ' ', '#fff', '#111', 1);
              sceneApi.current.redrawDecal(numDecal);
            };
          }

          if (!disposed) {
            setDiag(bake.diagnostics || null);
            setMode('baked');
            setStatus('ready'); setStep('');
          }
          return;                                  // baked path complete
        }
      }
      // Bake unavailable → keep the flat planar-projection path below.
      if (!disposed) setMode('flat');

      // 2 — the FAITHFUL flat design (GPT-image): the customer's EXACT design as a
      // flat front panel (wordmark, logo, pattern, colours all intact). We
      // planar-project it onto the mesh front so it lands correctly AND stays
      // rotatable 3D — the compositing model keeps the design, the mesh keeps 3D.
      setStep('Rendering your design faithfully…');
      const flat = await fetch(`/api/cdl/flat${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': project || 'augusta' },
        body: JSON.stringify({ sourceId }),
      }).then((r) => r.json()).catch(() => null);
      if (disposed) return;
      const flatId: string | undefined = flat?.flatId;

      const texLoader = new THREE.TextureLoader();
      const load = (url: string) => new Promise<THREE.Texture>((res, rej) =>
        texLoader.load(url, res, undefined, rej));

      setStep('Wrapping it onto the jersey…');
      const designTex = flatId ? await load(conceptUrl(flatId, project)).catch(() => null) : null;
      const normalTex = geo.normalMap ? await load(proxied(geo.normalMap, project)).catch(() => null) : null;
      if (disposed) return;
      if (designTex) { designTex.colorSpace = THREE.SRGBColorSpace; designTex.anisotropy = 8; }
      if (normalTex) normalTex.flipY = false;
      const matParams: THREE.MeshStandardMaterialParameters = {
        color: designTex ? 0xffffff : 0x1a1a1a,   // dark fallback reads as fabric, not grey error
        roughness: 0.62, metalness: 0.0, side: THREE.DoubleSide,
      };
      if (designTex) matParams.map = designTex;
      if (normalTex) matParams.normalMap = normalTex;
      const baseMaterial = new THREE.MeshStandardMaterial(matParams);
      sceneApi.current.baseMaterial = baseMaterial;

      // 3 — load the mesh, paint it with the design material.
      const useObj = geo.format === 'obj' && geo.obj;
      const meshUrl: string = useObj ? geo.obj : (geo.glb || geo.obj);
      const root: THREE.Object3D = await new Promise((res, rej) => {
        if (useObj) new OBJLoader().load(meshUrl, res, undefined, rej);
        else new GLTFLoader().load(meshUrl, (g: any) => res(g.scene), undefined, rej);
      }).catch(() => null) as any;
      if (disposed) return;
      if (!root) return fail('The 3D model could not be loaded.');
      root.updateMatrixWorld(true);
      root.traverse((child) => { const m = child as THREE.Mesh; if (m.isMesh) m.material = baseMaterial; });

      // 4 — PLANAR-PROJECT the flat design onto the mesh from the front (+Z):
      // recompute each vertex's UV from the garment's front-facing bounding box so
      // the flat design maps straight on — wordmark on the chest, number below,
      // pattern down the body. The front reads faithful; rotating shows it in 3D.
      const bb = new THREE.Box3().setFromObject(root);
      const bmin = bb.min.clone();
      const bsz = bb.getSize(new THREE.Vector3());
      let garment: THREE.Mesh | undefined;
      const wv = new THREE.Vector3();
      root.traverse((child) => {
        const m = child as THREE.Mesh;
        if (!m.isMesh || !m.geometry) return;
        if (!garment) garment = m;
        const g = m.geometry as THREE.BufferGeometry;
        const pos = g.attributes.position;
        const uv = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
          wv.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          uv[i * 2] = (wv.x - bmin.x) / (bsz.x || 1);
          uv[i * 2 + 1] = (wv.y - bmin.y) / (bsz.y || 1);
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.attributes.uv.needsUpdate = true;
      });
      if (!garment) return fail('The 3D model has no printable surface.');
      sceneApi.current.garment = garment;
      sceneApi.current.decals = [];   // design is baked into the projection; no decals

      // Frame the garment.
      frameAndAdd(root);

      if (!disposed) { setStatus('ready'); setStep(''); }
    })().catch((e) => fail(`Could not build the 3D design: ${e?.message || e}`));

    /* Project a decal onto the garment surface at its anchor (or at an explicit
       world point when the customer drags it). Rebuilds the DecalGeometry — the
       only correct way to move a projected decal. */
    const redrawDecal = (d: DecalDef, at?: { point: THREE.Vector3; normal: THREE.Vector3 }) => {
      const garment = sceneApi.current.garment;
      if (!garment) return;
      garment.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(garment);
      const size = box.getSize(new THREE.Vector3());
      const min = box.min;

      let point: THREE.Vector3, normal: THREE.Vector3;
      if (at) { point = at.point; normal = at.normal; }
      else {
        // Ray from outside the chosen face, through the anchor, onto the mesh.
        const wx = min.x + d.fx * size.x;
        const wy = min.y + d.fy * size.y;
        const front = d.face === 'front';
        const originZ = front ? box.max.z + size.z : box.min.z - size.z;
        const dir = new THREE.Vector3(0, 0, front ? -1 : 1);
        const ray = new THREE.Raycaster(new THREE.Vector3(wx, wy, originZ), dir);
        const hit = ray.intersectObject(garment, true)[0];
        if (!hit) return;
        point = hit.point;
        normal = hit.face ? hit.face.normal.clone().transformDirection(garment.matrixWorld) : dir.clone().negate();
      }

      // Orientation: look along the surface normal, keep world-up.
      const dummy = new THREE.Object3D();
      dummy.position.copy(point);
      dummy.lookAt(point.clone().add(normal));
      const euler = new THREE.Euler().copy(dummy.rotation);
      // Keep the projection THIN — deep enough to grip the near surface, but not
      // so deep it punches through and prints a ghost on the opposite side (the
      // "round shadow under the logo" bug: a back decal bleeding onto the front).
      const depth = Math.max(size.z * 0.18, d.size * 0.25);
      const dim = new THREE.Vector3(d.size, d.size / d.aspect, depth);

      if (d.mesh) { d.mesh.geometry.dispose(); sceneApi.current.scene?.remove(d.mesh); }
      const g = new DecalGeometry(sceneApi.current.garment!, point, euler, dim);
      const mat = new THREE.MeshStandardMaterial({
        map: d.texture, transparent: true, depthTest: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.7, side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.decalKind = d.kind;
      d.mesh = mesh;
      sceneApi.current.scene?.add(mesh);
    };
    sceneApi.current.redrawDecal = redrawDecal;

    /* Editing on the garment: pick a decal, drag it across the surface. */
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let dragging: DecalDef | null = null;
    const toNdc = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const onDown = (e: PointerEvent) => {
      toNdc(e); ray.setFromCamera(ndc, camera);
      const meshes = sceneApi.current.decals.map((d) => d.mesh!).filter(Boolean);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) {
        const kind = (hit.object as THREE.Mesh).userData.decalKind as DecalKind;
        dragging = sceneApi.current.decals.find((d) => d.kind === kind) || null;
        setSelected(kind);
        controls.enabled = false;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || !sceneApi.current.garment) return;
      toNdc(e); ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(sceneApi.current.garment, true)[0];
      if (!hit) return;
      const normal = hit.face ? hit.face.normal.clone().transformDirection(sceneApi.current.garment.matrixWorld)
        : new THREE.Vector3(0, 0, 1);
      redrawDecal(dragging, { point: hit.point, normal });
    };
    const onUp = () => { if (dragging) { dragging = null; controls.enabled = true; props.onEdited?.(); } };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      builtFor.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sku, sourceId, project]);

  // --- editor controls (act on the live scene) ---
  const resize = (delta: number) => {
    const d = sceneApi.current.decals.find((x) => x.kind === selected);
    if (!d) return;
    d.size = Math.max(0.02, d.size * (1 + delta));
    sceneApi.current.redrawDecal(d);
    props.onEdited?.();
  };
  const applyText = (kind: 'number' | 'name', value: string) => {
    const d = sceneApi.current.decals.find((x) => x.kind === kind);
    const text = kind === 'name' ? value.toUpperCase() : value;
    if (d) {
      d.texture = textTexture(text || ' ', '#fff', '#111', kind === 'name' ? 3.2 : 1);
      sceneApi.current.redrawDecal(d);
      props.onEdited?.();
    }
  };

  // Roster flip (baked mode): when the selected player changes — or the bake just
  // finished — repaint the back name/number for that player. One bake, whole squad.
  useEffect(() => {
    if (mode !== 'baked' || status !== 'ready' || !sceneApi.current.setBackText) return;
    const nm = roster ? (roster[playerIdx]?.name || '') : name;
    const no = roster ? (roster[playerIdx]?.number || '') : number;
    if (roster) { setName(nm); setNumber(no); }
    sceneApi.current.setBackText(nm, no);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerIdx, mode, status]);

  const muted = 'var(--text-muted,#888)';
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {status !== 'ready' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                        justifyContent: 'center', textAlign: 'center', padding: 20,
                        color: muted, fontSize: 13, background: 'var(--stage-bg,#fff)' }}>
            {status === 'failed' ? `⚠ ${step}` : (
              <span><span className="cd3d-spin" style={{ display: 'inline-block', marginRight: 8 }}>◔</span>{step}</span>
            )}
          </div>
        )}
        {status === 'ready' && (
          <div style={{ position: 'absolute', top: 10, left: 12, fontSize: 10.5, fontWeight: 700,
                        letterSpacing: 0.5, textTransform: 'uppercase', color: muted,
                        background: 'rgba(255,255,255,0.85)', padding: '3px 8px', borderRadius: 6 }}>
            {mode === 'baked'
              ? 'Your design · baked onto the real jersey · drag to rotate'
              : 'Your design · on the real jersey · drag to move'}
          </div>
        )}
      </div>

      {/* BAKED mode — the design DATA the bake extracted: palette+hex, coverage,
          fit verdict. This is the "nothing coming out" fix: the colours and the
          confidence are shown, not hidden. */}
      {status === 'ready' && mode === 'baked' && diag && showData && (
        <div style={{ padding: '9px 11px', borderTop: '1px solid var(--border)',
                      display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5,
                           textTransform: 'uppercase', color: muted }}>Design data</span>
            {diag.verdict && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
                             color: verdictColour(diag.verdict).fg, background: verdictColour(diag.verdict).bg }}>
                {diag.verdict === 'good' ? 'faithful fit' : diag.verdict}
              </span>
            )}
            <button onClick={() => setShowData(false)} style={{ ...btn, width: 'auto', height: 22, padding: '0 8px',
                     fontSize: 11, fontWeight: 600, marginLeft: 'auto' }}>hide</button>
          </div>
          {/* Palette swatches with hex — the recolour set, now visible. */}
          {!!diag.palette?.length && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {diag.palette.slice(0, 6).map((p, i) => (
                <span key={i} title={`${p.hex} · ${Math.round(p.share)}%`}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: muted }}>
                  <span style={{ width: 16, height: 16, borderRadius: 4, background: p.hex,
                                 border: '1px solid rgba(0,0,0,0.15)' }} />
                  <code style={{ fontSize: 10 }}>{p.hex}</code>
                </span>
              ))}
            </div>
          )}
          {/* Coverage + per-view fit. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 10.5, color: muted }}>
            {typeof diag.coverage === 'number' && <span>Coverage <b style={{ color: 'var(--text,#111)' }}>{Math.round(diag.coverage)}%</b></span>}
            {diag.atlas && <span>Texture <b style={{ color: 'var(--text,#111)' }}>{diag.atlas}</b></span>}
            {diag.views?.map((v) => (
              <span key={v.view}>{v.view} <b style={{ color: v.locked ? '#137333' : '#a15c00' }}>
                {Math.round(v.iou * 100)}%{v.locked ? '' : '≈'}</b></span>
            ))}
          </div>
          {/* Roster overlay (AUG-32): flip through players — the back name/number
              repaints instantly on the ONE baked garment. */}
          {roster && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 2 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4,
                             textTransform: 'uppercase', color: muted }}>Roster</span>
              <button onClick={() => setPlayerIdx((i) => (i - 1 + roster.length) % roster.length)}
                      style={{ ...btn, width: 24, height: 24, fontSize: 14 }}>‹</button>
              <span style={{ fontSize: 12, minWidth: 130, textAlign: 'center' }}>
                <b>{roster[playerIdx]?.name || '—'}</b>
                {roster[playerIdx]?.number ? ` · #${roster[playerIdx].number}` : ''}
              </span>
              <button onClick={() => setPlayerIdx((i) => (i + 1) % roster.length)}
                      style={{ ...btn, width: 24, height: 24, fontSize: 14 }}>›</button>
              <span style={{ fontSize: 10.5, color: muted }}>{playerIdx + 1}/{roster.length}</span>
            </div>
          )}
          {/* Name/number — editable, and it repaints the back on the 3D garment.
              For a roster this edits the selected player's shown lettering. */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 2 }}>
            <label style={{ fontSize: 11, color: muted }}>Name
              <input value={name} onChange={(e) => { setName(e.target.value); sceneApi.current.setBackText?.(e.target.value, number); props.onEdited?.(); }}
                     style={inp} placeholder="NAME" />
            </label>
            <label style={{ fontSize: 11, color: muted }}>No.
              <input value={number} onChange={(e) => { const n = e.target.value.replace(/\D/g, '').slice(0, 2); setNumber(n); sceneApi.current.setBackText?.(name, n); props.onEdited?.(); }}
                     style={{ ...inp, width: 44 }} placeholder="00" />
            </label>
          </div>
        </div>
      )}
      {status === 'ready' && mode === 'baked' && diag && !showData && (
        <div style={{ padding: '6px 11px', borderTop: '1px solid var(--border)' }}>
          <button onClick={() => setShowData(true)} style={{ ...btn, width: 'auto', height: 24, padding: '0 10px',
                   fontSize: 11, fontWeight: 600 }}>Show design data</button>
        </div>
      )}

      {/* FLAT fallback — the decal edit bar (drag/resize/text on the garment). */}
      {status === 'ready' && mode === 'flat' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '8px 10px', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11.5, color: muted }}>
            {selected ? `Editing: ${selected}` : 'Tap the logo, name or number on the jersey to edit it'}
          </span>
          {selected === 'logo' && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => resize(-0.12)} style={btn}>–</button>
              <button onClick={() => resize(0.12)} style={btn}>+</button>
              <span style={{ fontSize: 11, color: muted, alignSelf: 'center' }}>size</span>
            </span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: muted }}>Name
              <input value={name} onChange={(e) => { setName(e.target.value); applyText('name', e.target.value); }}
                     style={inp} placeholder="TEAM" />
            </label>
            <label style={{ fontSize: 11, color: muted }}>No.
              <input value={number} onChange={(e) => { setNumber(e.target.value.replace(/\D/g, '').slice(0, 2)); applyText('number', e.target.value.replace(/\D/g, '').slice(0, 2)); }}
                     style={{ ...inp, width: 44 }} placeholder="00" />
            </label>
          </span>
        </div>
      )}
      <style>{`@keyframes cd3dspin{to{transform:rotate(360deg)}}.cd3d-spin{animation:cd3dspin 1s linear infinite}`}</style>
    </div>
  );
}

/** Verdict pill colours — reads at a glance whether the wrap fit cleanly. */
function verdictColour(v: string): { fg: string; bg: string } {
  if (v === 'good') return { fg: '#137333', bg: 'rgba(19,115,51,0.12)' };
  if (v === 'usable') return { fg: '#a15c00', bg: 'rgba(161,92,0,0.12)' };
  if (v === 'poor') return { fg: '#b00020', bg: 'rgba(176,0,32,0.12)' };
  return { fg: '#666', bg: 'rgba(0,0,0,0.06)' };
}

const btn: React.CSSProperties = {
  width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)',
  background: '#fff', cursor: 'pointer', fontSize: 15, fontWeight: 700, lineHeight: 1,
};
const inp: React.CSSProperties = {
  marginLeft: 6, width: 84, padding: '4px 6px', borderRadius: 6,
  border: '1px solid var(--border)', fontSize: 12,
};
