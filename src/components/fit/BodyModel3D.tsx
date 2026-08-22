'use client';

import { ReactNode, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodyZone, ZoneFit } from '@/lib/advisor-types';
import { BodyMeasurements, LANDMARK, Ring, garmentRings, interpolate } from '@/services/fit/body-mesh';
import {
  DEFAULT_SILHOUETTE, bodyField, garmentField, hemHeight, surfaceNet,
} from '@/services/fit/body-sdf';
import { GarmentSilhouette } from '@/lib/advisor-types';

/**
 * The 3D avatar.
 *
 * Built from the shopper's own circumferences rather than scaled from a
 * stock model — see services/fit/body-mesh.ts for the geometry. The garment
 * is a second surface at the real ease, so the gap you can see between the
 * two IS the fit. Nothing is exaggerated here.
 *
 * Drag to turn it. It idles with a slow rotation and stops the moment
 * anyone touches it, because a model that keeps spinning while you are
 * trying to look at the shoulder is infuriating.
 *
 * Written against raw three.js rather than a React renderer: one dependency,
 * no reconciler to keep in step with React's release train, and the scene is
 * rebuilt only when the measurements actually change.
 */

export interface BodyModel3DProps {
  body: BodyMeasurements;
  zones: ZoneFit[];
  category: 'top' | 'bottom';
  stretchIn: number;
  size: string;
  /** Which zone to highlight, when the shopper is dragging its slider. */
  focus?: BodyZone | null;
  /** Shown instead when WebGL is unavailable. */
  fallback?: ReactNode;
  /** The garment's drawn shape — sleeve length, hem, collar. */
  silhouette?: GarmentSilhouette;
}

/**
 * Is WebGL available at all? Old machines, locked-down browsers and some VMs
 * have none. Cached because creating throwaway canvases is not free, and
 * checked during render rather than in an effect so the fallback appears on
 * the first paint instead of after a flash of empty box.
 */
let webglSupport: boolean | null = null;
export function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  if (typeof document === 'undefined') return true;   // SSR: assume yes
  try {
    const c = document.createElement('canvas');
    webglSupport = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

const TONE: Record<ZoneFit['verdict'], number> = {
  'very-tight': 0x9a4a38,
  snug: 0xa67c4e,
  'just-right': 0x4e7c59,
  relaxed: 0xa67c4e,
  loose: 0x9a4a38,
};

/** Inches → world units. Keeps a 70″ person about 1.75 units tall. */
const S = 0.025;

export default function BodyModel3D({
  body, zones, category, stretchIn, size, focus, fallback, silhouette,
}: BodyModel3DProps) {
  const supported = useMemo(() => hasWebGL(), []);
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    framing: { y: number; z: number; ready: boolean };
    dispose: () => void;
  } | null>(null);

  // ── Set up once ──────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !supported) return;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // Keeps the frame readable after it is drawn, so the canvas can be
      // screenshotted or inspected. Without it the buffer is cleared on
      // present and anything reading it back sees transparent black.
      preserveDrawingBuffer: true,
    });
    // Filmic tone mapping is the single biggest step away from the flat,
    // plastic look of default WebGL output — it rolls off highlights instead
    // of clipping them, which is what makes rendered cloth read as cloth.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const width = mount.clientWidth || 320;
    const height = mount.clientHeight || 420;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 100);
    camera.position.set(0, 0.95, 4.6);

    // Image-based lighting. A room environment gives every surface hundreds
    // of soft reflections to catch, which is what separates a rendered
    // product from a lit primitive. Three point lights cannot fake it.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    // One directional light on top, purely to shape the form and throw the
    // contact shadow. The environment is doing the actual lighting.
    const key = new THREE.DirectionalLight(0xfff6ec, 0.95);
    key.position.set(1.1, 6.2, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.camera.left = -1.6;
    key.shadow.camera.right = 1.6;
    key.shadow.camera.top = 2.6;
    key.shadow.camera.bottom = -0.6;
    key.shadow.bias = -0.0012;
    key.shadow.radius = 9;
    scene.add(key);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // A shadow-catching plane at the feet. Invisible except where the figure
    // darkens it, so the model sits on something instead of floating.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.ShadowMaterial({ opacity: 0.12 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.minPolarAngle = Math.PI * 0.30;
    controls.maxPolarAngle = Math.PI * 0.70;
    // Three-quarter views only. A shopper gains nothing from the back of a
    // mannequin, and an unconstrained orbit lets them find the one angle a
    // procedurally generated body is weakest at. This is a limit, not a fix:
    // a proper rigged base mesh is what removes the need for it.
    controls.minAzimuthAngle = -Math.PI * 0.26;
    controls.maxAzimuthAngle = Math.PI * 0.26;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.target.set(0, 0.85, 0);

    const group = new THREE.Group();
    scene.add(group);

    // The camera glides to its new framing rather than cutting. When someone
    // drags a measurement the figure changes size, and a hard jump each time
    // reads as a glitch; easing reads as the model responding.
    const framing = { y: 0.9, z: 4.6, ready: false };
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (framing.ready) {
        // Ease the height and the distance, leaving the shopper's own
        // rotation alone — nudging their angle back would feel like a fight.
        const k = reduceMotion ? 1 : 0.09;
        camera.position.y += (framing.y - camera.position.y) * k;
        const flat = Math.hypot(camera.position.x, camera.position.z) || 1;
        const scale = 1 + ((framing.z - flat) / flat) * k;
        camera.position.x *= scale;
        camera.position.z *= scale;
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    const onResize = () => {
      const w = mount.clientWidth || width;
      const h = mount.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    const dispose = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeChildren(group);
      envRT.texture.dispose();
      pmrem.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };

    sceneRef.current = { renderer, scene, camera, controls, group, framing, dispose };
    return dispose;
  }, [supported]);

  // ── Rebuild the figure whenever the measurements change ──────────────
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;

    disposeChildren(ctx.group);

    const worst = zones.length
      ? [...zones].sort((a, b) => Math.abs(b.position - 0.5) - Math.abs(a.position - 0.5))[0]
      : null;
    const garmentColor = worst ? TONE[worst.verdict] : TONE['just-right'];

    // Meshing an implicit surface costs real time, so drop the grid while a
    // measurement is being dragged and go back to full detail the moment the
    // shopper lets go. `focus` is set precisely for the duration of a drag,
    // so it doubles as the signal for this with no extra state.
    buildFigure(ctx.group, {
      body, zones, category, stretchIn, garmentColor,
      focus: focus ?? null,
      resolution: focus ? 34 : 56,
      silhouette,
    });

    // Frame the whole figure: solve the camera distance from its actual
    // height and the vertical FOV rather than guessing, so a 5′0″ and a 6′6″
    // build are both fully in shot with the same headroom.
    const figureH = body.heightIn * S;
    const mid = figureH * 0.52;
    const vFov = (ctx.camera.fov * Math.PI) / 180;
    const dist = (figureH * 0.62) / Math.tan(vFov / 2);
    ctx.controls.target.set(0, mid, 0);
    ctx.framing.y = mid + figureH * 0.05;
    ctx.framing.z = dist;
    if (!ctx.framing.ready) {
      // First build: no glide, just be in the right place.
      // Three-quarter opening angle: a dead-on view flattens any figure.
      ctx.camera.position.set(dist * 0.34, ctx.framing.y, dist * 0.94);
      ctx.framing.ready = true;
    }
  }, [body, zones, category, stretchIn, focus, silhouette]);


  if (!supported) return <>{fallback}</>;

  return (
    <div className="adv-3d">
      <div className="adv-3d__stage" ref={mountRef} />
      <div className="adv-3d__hint">
        <span className="adv-3d__size">{size}</span>
        <span>Drag to turn</span>
      </div>
    </div>
  );
}

// ── Geometry ───────────────────────────────────────────────────────────

function disposeChildren(group: THREE.Group) {
  const doomed = [...group.children];
  for (const child of doomed) {
    group.remove(child);
    child.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose());
      else mat?.dispose();
    });
  }
}



/** Add a mesh to the group with shadows on. */
function add(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

function buildFigure(
  group: THREE.Group,
  o: {
    body: BodyMeasurements;
    zones: ZoneFit[];
    category: 'top' | 'bottom';
    stretchIn: number;
    garmentColor: number;
    focus: BodyZone | null;
    resolution: number;
    silhouette?: GarmentSilhouette;
  }
) {
  const { body, zones, category, stretchIn, garmentColor, focus, resolution, silhouette } = o;
  const H = body.heightIn;

  const skin = new THREE.MeshPhysicalMaterial({
    color: 0xdcd4c6,
    roughness: 0.6,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.52,
    sheen: 0.25,
    sheenColor: new THREE.Color(0xfff2e2),
    envMapIntensity: 0.9,
  });

  const cloth = new THREE.MeshPhysicalMaterial({
    color: garmentColor,
    roughness: 0.9,
    metalness: 0,
    sheen: 0.9,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0xffffff),
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    envMapIntensity: 0.65,
  });

  // ── One continuous body ──────────────────────────────────────────────
  add(group, toGeometry(surfaceNet(bodyField(body), resolution)), skin);

  // ── One continuous garment ───────────────────────────────────────────
  const ease: { chest?: number; waist?: number; hip?: number } = {};
  for (const z of zones) {
    if (z.zone === 'chest' || z.zone === 'waist' || z.zone === 'hip') ease[z.zone] = z.easeIn;
  }
  const gRings = garmentRings(body, ease, { category, stretchIn });
  const legZone = zones.find(z => z.zone === 'inseam') ?? null;
  const sil = silhouette ?? DEFAULT_SILHOUETTE;

  // The declared hem is the pattern's intent; a measured inseam overrides it,
  // because a 30" leg and a 34" leg on the same style really do end in
  // different places.
  let hemY = hemHeight(body, sil);
  if (category === 'bottom' && legZone) {
    const ankle = body.heightIn * 0.035;
    const crotch = body.heightIn * LANDMARK.crotch;
    hemY = Math.max(ankle * 0.6, Math.min(crotch - 2, hemY - legZone.easeIn * -1));
  }

  add(group, toGeometry(surfaceNet(garmentField(body, {
    category, rings: gRings, hemY, stretchIn, silhouette: sil,
  }), Math.round(resolution * 0.92))), cloth);

  // ── Measurement bands ────────────────────────────────────────────────
  for (const z of zones) {
    if (z.zone === 'inseam') continue;
    const y = H * LANDMARK[z.zone];
    const r = interpolate(gRings, y);
    const highlighted = focus === z.zone;
    const band = new THREE.Mesh(
      ringGeometry(r, y, highlighted ? 0.026 : 0.011),
      new THREE.MeshBasicMaterial({
        color: TONE[z.verdict],
        transparent: true,
        opacity: highlighted ? 0.92 : 0.34,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    band.renderOrder = 2;
    group.add(band);
  }
}

/** Surface-net output, in inches, into a scaled three.js geometry. */
function toGeometry(mesh: { positions: Float32Array; indices: Uint32Array }): THREE.BufferGeometry {
  const scaled = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i++) scaled[i] = mesh.positions[i] * S;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(scaled, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geo.computeVertexNormals();
  return geo;
}


/** A flat annulus hugging an elliptical ring, used as a measurement band. */
function ringGeometry(r: Ring, y: number, thickness: number): THREE.BufferGeometry {
  const segments = 48;
  const pos: number[] = [];
  const idx: number[] = [];
  const pad = 0.4; // sit just proud of the surface so it never z-fights
  for (let s = 0; s <= segments; s++) {
    const t = (s / segments) * Math.PI * 2;
    const x = Math.cos(t), z = Math.sin(t);
    pos.push(x * (r.a + pad) * S, (y * S) + thickness / 2, (z * (r.b + pad) + r.z) * S);
    pos.push(x * (r.a + pad) * S, (y * S) - thickness / 2, (z * (r.b + pad) + r.z) * S);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
