'use client';

/**
 * Garment configurator — the real mesh, wearing the real print.
 *
 * The brand's own tooling composes a TEXTURE ATLAS: every cut panel of the
 * garment laid flat with the design line, colours and lettering burned in — the
 * same artwork that drives the sublimation printer. Each style also ships a mesh
 * exported from Blender whose UVs place those panels where they belong. Put one
 * on the other and you get the actual product, not an impression of it.
 *
 * Two deliberate choices:
 *
 *  1. The mesh is the STYLE'S OWN geometry, never a hand-rolled approximation.
 *     An earlier version drew a generic jersey shape in code; showing a guess of
 *     something the customer is about to pay to have printed is worse than
 *     showing nothing, so if the real mesh is unavailable we say so.
 *
 *  2. There are no colour swatches or text inputs here. The customer describes
 *     what they want and the agent applies it — this panel's job is to show the
 *     result and let them turn it around, not to make them operate a form. The
 *     only interaction is the camera.
 *
 * Both assets load through our own /api/products/asset proxy: the imaging host
 * refuses cross-origin reads outright (403) and the model host sends no CORS
 * headers, so a direct fetch yields a tainted texture and a blank canvas.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { activeSessionId } from '@/lib/conversations';
import { useJourney } from '@/context/JourneyContext';

interface RenderResult {
  /** The style the server actually rendered. The identity shown to the customer
   *  is derived from THIS, never from what was requested — otherwise the caption
   *  can name one garment while the viewer shows another. */
  style?: string;
  renderable?: boolean;
  texture?: string;
  geometry?: { glb: string; obj?: string; mtl?: string; normalMap?: string; envMap?: string; format?: 'glb' | 'obj' };
  rejectedColours?: string[];
  /** The design line the garment is actually wearing — may be one the server
   *  chose because none was named. The caption must reflect what is on screen. */
  appliedDesignLine?: string;
  designLineDefaulted?: boolean;
  /** Zones that had to reuse a chosen colour because the design has more zones
   *  than colours supplied. Not an error, but the customer must be told. */
  zonesFilledByRepeat?: number;
  reason?: 'no-atlas' | 'design-line-not-on-style' | 'no-body-zone' | 'no-design-line' | 'no-mesh';
  catalogueImage?: string;
  designLines?: { slug: string; label: string }[];
  /** Where each editable text sits on the garment, in atlas UV space. */
  textZones?: { key: string; slot: string; uv: [number, number, number, number] }[];
  /** Lettering positions this style prints. Absent/empty = takes no lettering,
   *  so the name and number fields are withheld rather than offered falsely. */
  letteringSlots?: string[];
  /**
   * Headwear (CAP-1). A cap is coloured per mesh rather than by a composed
   * atlas, so these arrive INSTEAD of `texture`, and the viewer branches on
   * their presence rather than on a missing texture.
   */
  decorationSystem?: 'cap';
  capColourway?: { code: string; name?: string; meshes: Record<string, string> };
  capColours?: { code: string; name?: string }[];
  /** False when this cap is not made in the colour the customer asked for. */
  colourMatched?: boolean;
  notes?: string[];
}

/**
 * Customer-facing copy for a limited preview.
 *
 * `notes` from the server are DIAGNOSTICS — they are written for us and contain
 * instructions to the implementation ("show the catalogue photo instead"). They
 * must never reach a customer. The UI writes its own sentence from the reason
 * code, in the customer's language, and says what happens next.
 */
function explain(r: RenderResult): string {
  const lines = (r.designLines || []).map((d) => d.label).slice(0, 6).join(', ');
  switch (r.reason) {
    case 'no-atlas':
      return r.catalogueImage
        ? 'This style is not available in the 3D preview yet, so here is the catalogue photo.'
        : 'This style is not available in the 3D preview yet. Everything else about your order still works.';
    case 'design-line-not-on-style':
      return lines
        ? `That design is not offered on this style. Available here: ${lines}.`
        : 'That design is not offered on this style.';
    case 'no-mesh':
      return 'No 3D model for this style yet — this is the print itself, laid out flat.';
    default:
      return 'Preview unavailable for this style.';
  }
}

/** Route an external asset through our own origin. */
/** Tallest the garment popup may grow before it scrolls internally. */
const POPUP_MAX_H = 300;

const proxied = (url: string, project: string) =>
  `/api/products/asset?url=${encodeURIComponent(url)}${project ? `&project=${encodeURIComponent(project)}` : ''}`;

export default function ConfiguratorPanel() {
  const cfg = useStorefrontConfig();
  const { state, dispatch } = useJourney();
  const design = state.design || {};

  const mountRef = useRef<HTMLDivElement | null>(null);
  const [render, setRender] = useState<RenderResult>({});
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'flat' | 'photo' | 'failed'>('idle');
  const [detail, setDetail] = useState<string>('');
  /* What the customer clicked on the garment, and where on screen to anchor the
     editor. Editing happens ON the thing being edited — not in a sidebar and
     not by typing into chat. */
  const [editing, setEditing] = useState<{ key: string; x: number; y: number; value: string } | null>(null);
  /* Clicking the garment anywhere OTHER than the lettering opens the variant
     picker at that point — colours and design lines for this style. */
  const [variants, setVariants] = useState<{ x: number; y: number } | null>(null);
  const [rackOpen, setRackOpen] = useState(false);
  const [pricing, setPricing] = useState(false);
  /* What the kit currently comes to, for the pill and the rack.
   *
   * Priced by the SAME server engine as the quote screen, never added up here:
   * a running total the customer reads as "the price" must not be able to
   * disagree with the quote they are about to approve, and the browser has no
   * business doing arithmetic on money (P0-04). It also carries the roster
   * quantity, so the figure is the real order value rather than a unit price. */
  const [kitTotal, setKitTotal] = useState<{ symbol: string; total: number } | null>(null);
  const [rack, setRack] = useState<{ type: string; items: { sku: string; name?: string; renderable: boolean }[] }[]>([]);
  const [palette, setPalette] = useState<string[]>([]);
  const kit = state.kit || [];
  /** Which garment type is on the stage, so "add this ___" names it correctly. */
  const currentType = rack.find((g) => g.items.some((i) => i.sku === design.sku))?.type;

  /* The click handler is installed once with the scene, but must always see the
     LATEST design and zones — rebuilding the WebGL scene on every keystroke to
     keep a closure fresh would be absurd. */
  /* The loaded cap mesh group, kept so a colour change can re-paint it in place
     instead of reloading the 12MB GLB and resetting the camera (the "static cap"
     bug: a cap's colour lives in capColourway.meshes, which is NOT a dependency
     of the scene-build effect, so changing it never re-ran that effect). */
  const capRootRef = useRef<THREE.Object3D | null>(null);
  const zonesRef = useRef<RenderResult['textZones']>(undefined);
  const designRef = useRef(design);
  useEffect(() => { zonesRef.current = render.textZones; }, [render.textZones]);
  useEffect(() => { designRef.current = design; }, [design]);

  const project = useMemo(
    () => (typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('project') || ''),
    [],
  );

  useEffect(() => {
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    fetch(`/api/products/renderer-config${q}`).then((r) => r.json())
      .then((c: { palette?: string[] }) => setPalette(c?.palette || [])).catch(() => {});
    fetch(`/api/products/rack${q}`).then((r) => r.json())
      .then((d: any) => setRack(d?.groups || [])).catch(() => {});
  }, [project]);

  const colours = useMemo(
    () => [design.baseColor, design.accentColor].filter(Boolean) as string[],
    [design.baseColor, design.accentColor],
  );

  /* Real values for the inks on this garment (AUG-81).
   *
   * The catalogue derives them from the brand's own renderer, so a chip shows
   * what will be printed rather than a CSS reading of the colour's name.
   * Unresolved names stay absent and render as "unknown" — a wrong swatch is
   * the one error a customer cannot catch before it is on 14 jerseys. */
  const [inks, setInks] = useState<Record<string, string>>({});
  const inkKey = colours.join('|');
  useEffect(() => {
    if (!colours.length) return;
    let alive = true;
    fetch(`/api/products/colours${project ? `?project=${encodeURIComponent(project)}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: colours }),
    })
      .then((r) => r.json())
      .then((d) => { if (alive) setInks((prev) => ({ ...prev, ...(d?.colours || {}) })); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inkKey, project]);

  /* Re-price whenever the rack changes. Debounced: adding three garments in a
     row should cost one call, not three. A failure leaves the previous figure
     alone rather than flashing a wrong one — no number is better than a number
     the customer cannot trust. */
  const kitKey = kit.map((k) => k?.sku).filter(Boolean).join('|');
  useEffect(() => {
    if (!kitKey) { setKitTotal(null); return; }
    let alive = true;
    const t = setTimeout(async () => {
      /* Retry a couple of times before giving up. This effect only re-runs when
         the rack CHANGES, so a single transient failure — a service reloading,
         a dropped connection — would leave the total blank for the rest of the
         session with nothing to trigger another attempt. */
      for (let attempt = 0; attempt < 3 && alive; attempt++) {
        try {
          const res = await fetch(`/api/kit/quote?project=${encodeURIComponent(cfg.projectId || '')}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: kitKey.split('|').map((sku) => ({ sku })),
              sessionId: activeSessionId(cfg.projectId),
              title: 'Kit running total',
            }),
          });
          const d = await res.json();
          if (!alive) return;
          if (d?.quote) {
            setKitTotal({ symbol: d.quote.symbol || '$', total: d.quote.total || 0 });
            return;
          }
        } catch { /* fall through to the retry */ }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      // Still nothing: keep the last good figure rather than show a wrong one.
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [kitKey, cfg.projectId]);
  const colourKey = colours.join('|');

  /* Ask the server for the atlas + mesh. Debounced, because each request is a
     real server-side composite rather than a local redraw. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!design.sku) { setRender({}); setStatus('idle'); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus('loading'); setDetail('');
      try {
        const res = await fetch(
          `/api/products/render${project ? `?project=${encodeURIComponent(project)}` : ''}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              style: design.sku,
              colours,
              designLine: design.designLine,
              textColour: design.textColour,
              outlineColour: design.outlineColour,
              text: {
                teamName: design.name || undefined,
                number: design.number || undefined,
                numberSmall: design.number || undefined,
              },
            }),
          },
        );
        const data: RenderResult = await res.json();
        setRender(data);
        if (!data.renderable || !data.texture) {
          setStatus(data.catalogueImage ? 'photo' : 'failed');
          setDetail(explain(data));
        } else if (!data.geometry) {
          // The print is real even when the 3D mesh for this style is not
          // available — show the artwork flat rather than nothing at all.
          setStatus('flat');
        }
      } catch {
        setStatus('failed');
        setDetail('The preview service is not responding. Your design is saved — nothing is lost.');
      }
    }, 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [design.sku, colourKey, design.name, design.number,
      design.designLine, design.textColour, design.outlineColour, project]);

  /* Build the scene once we have both the mesh and the atlas. */
  useEffect(() => {
    const mount = mountRef.current;
    /* A cap carries a colourway instead of a texture, so requiring a texture
       here would silently refuse to build a scene for every cap — renderable,
       with a mesh, and nothing on screen. Each path asserts what it needs. */
    const isCap = !!render.capColourway;
    if (!mount || !render.renderable || !render.geometry) return;
    if (!isCap && !render.texture) return;

    let disposed = false;
    let cleanupFit: (() => void) | null = null;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Soft, even lighting — this stands in for a photography set, so the
    // customer judges the print rather than the lighting.
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 4);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-3, 1, -2);
    scene.add(key, fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;

    mount.appendChild(renderer.domElement);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      // updateStyle must stay ON. With it off the canvas keeps its drawing
      // buffer size as its CSS size, so a devicePixelRatio of 2 lays out a
      // canvas twice the container's width and the garment overflows the panel.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let frame = 0;
    const loop = () => { frame = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();

    /* Click the lettering ON the garment to edit it.
     *
     * The raycast returns the UV coordinate of the point touched; whichever
     * text zone's rectangle contains it is the thing the customer meant. The
     * rectangles are measured from the atlas itself at ingest, so this works on
     * any style and follows the real shape — on some styles the team name runs
     * vertically, which a hand-placed "chest strip" would have missed entirely.
     *
     * A drag is how you turn the garment, so only a press-and-release that
     * barely moves counts as a click. */
    const raycaster = new THREE.Raycaster();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      const moved = downAt
        ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 999;
      downAt = null;
      if (moved > 4) return;                       // that was a rotate, not a tap
      /* Text zones are OPTIONAL here. A garment with no lettering (a plain
         bottom, an accessory) still has colours and design lines to change, so
         bailing out when zones are absent made the whole garment unclickable —
         which is exactly what happened on the shorts. */
      const zones = zonesRef.current || [];

      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      ), camera);
      const hit = raycaster.intersectObjects(scene.children, true)
        .find((i) => (i.object as THREE.Mesh).isMesh && i.uv);
      if (!hit?.uv) { setEditing(null); setVariants(null); return; }

      // The atlas is sampled with flipY=false, so V is already top-down here.
      const u = hit.uv.x, v = hit.uv.y;
      const zone = zones.find((z) =>
        u >= z.uv[0] && u <= z.uv[2] && v >= z.uv[1] && v <= z.uv[3]);
      // No lettering here (or none on this garment at all) → offer the look.
      if (!zone) {
        // Not the lettering, but still the garment — offer what CAN be changed
        // here: this style's real design lines and the brand's real colours.
        setEditing(null);
        setVariants({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        return;
      }
      setVariants(null);

      const current = zone.key === 'teamName' ? (designRef.current.name || '')
        : (designRef.current.number || '');
      setEditing({ key: zone.key, x: e.clientX - rect.left, y: e.clientY - rect.top, value: current });
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    // Only the texture needs proxying — the imaging host refuses cross-origin
    // reads. The mesh CDN sends `access-control-allow-origin: *`, so geometry
    // loads straight from source and skips a round trip through us.
    // Most styles ship a glTF; a few were never re-exported and are OBJ only.
    // The server tells us which one actually exists for this style.
    const useObj = render.geometry.format === 'obj';
    const meshUrl = (useObj ? render.geometry.obj : render.geometry.glb) || render.geometry.glb;
    if (!meshUrl) return;

    const texUrl = render.texture ? proxied(render.texture, project) : '';
    const loader = new THREE.TextureLoader();
    const texture = !texUrl ? null : loader.load(
      texUrl,
      undefined,
      undefined,
      () => { if (!disposed) { setStatus('failed'); setDetail('The print could not be loaded onto the garment.'); } },
    );
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;   // glTF UVs originate bottom-left; images do not.
    }

    // The normal map carries the fabric weave and stitch relief. Without it the
    // garment reads as a flat decal rather than cloth.
    const normal = render.geometry.normalMap
      ? loader.load(render.geometry.normalMap)
      : null;
    if (normal) normal.flipY = false;

    const onLoaded = (root: THREE.Object3D) => {
        if (disposed) return;

        /* Headwear is coloured per mesh, not by an atlas (CAP-1).
         *
         * The platform authors a colourway as a map of mesh name → hex, so the
         * crown, visor, button and stitching each take their own colour from
         * the mesh they belong to. There is no texture and no UV layout to
         * respect; painting one atlas across all of them would flatten a
         * six-part cap into a single slab of colour.
         *
         * A mesh the colourway does not name keeps the material it shipped
         * with rather than being forced to a default — those are the
         * decoration and non-colour parts (logos, inner bindings), and
         * repainting them would erase detail the customer can see on the
         * live site. */
        const capMeshes = render.capColourway?.meshes;
        let capPainted = 0;

        root.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;

          if (capMeshes) {
            const hex = capMeshes[mesh.name];
            if (!hex) return;                    // keep the mesh's own material
            mesh.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color(`#${hex}`),
              roughness: 0.78,
              metalness: 0.0,
              side: THREE.DoubleSide,
            });
            capPainted++;
            return;
          }

          // The atlas already carries colour and lettering, so every material is
          // just a window onto it — the UVs decide which panel shows where.
          // Replacing them wholesale avoids inheriting the export's placeholder.
          mesh.material = new THREE.MeshStandardMaterial({
            map: texture,
            normalMap: normal || undefined,
            roughness: 0.72,
            metalness: 0.0,
            side: THREE.DoubleSide,
          });
        });

        /* A cap whose mesh names do not match the colourway would render in its
         * export colours while the customer believes they chose navy. Reported
         * rather than left to look deliberate — this is the per-style mesh-name
         * trap, and it must fail loudly if it ever bites. */
        if (capMeshes && !capPainted) {
          console.warn(`[configurator] cap colourway matched no mesh on ${render.style}`);
        }

        scene.add(root);
        // Keep the cap group so a later colour change re-paints it in place.
        capRootRef.current = capMeshes ? root : null;

        // Frame the garment. The distance has to come from the field of view
        // and the viewport aspect, not a guessed multiplier — a garment that is
        // tall and narrow overflows sideways otherwise, and mesh scale varies
        // wildly between styles.
        const fit = () => {
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const centre = box.getCenter(new THREE.Vector3());
          root.position.sub(centre);

          const vFov = (camera.fov * Math.PI) / 180;
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
          const distV = (size.y / 2) / Math.tan(vFov / 2);
          const distH = (Math.max(size.x, size.z) / 2) / Math.tan(hFov / 2);
          const dist = Math.max(distV, distH) * 1.25;   // breathing room

          camera.position.set(0, 0, dist);
          camera.near = dist / 100;
          camera.far = dist * 100;
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.minDistance = dist * 0.4;
          controls.maxDistance = dist * 2.5;
          controls.update();
        };
        fit();
        // Re-fit on resize: the horizontal bound depends on the aspect ratio.
        ro.disconnect();
        ro.observe(mount);
        const onResize = () => { resize(); fit(); };
        window.addEventListener('resize', onResize);
        cleanupFit = () => window.removeEventListener('resize', onResize);

        setStatus('ready');
    };
    const onMeshError = () => {
      if (!disposed) { setStatus('failed'); setDetail('The garment model could not be loaded.'); }
    };
    if (useObj) {
      new OBJLoader().load(meshUrl, onLoaded, undefined, onMeshError);
    } else {
      new GLTFLoader().load(meshUrl, (g) => onLoaded(g.scene), undefined, onMeshError);
    }

    return () => {
      disposed = true;
      capRootRef.current = null;
      cleanupFit?.();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      texture?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [render.texture, render.geometry?.glb, render.geometry?.format, render.renderable, project]);

  /* Re-paint the cap in place when the colourway changes (CAP-1 / "static cap"
     fix). The scene-build effect above intentionally does NOT depend on the
     colourway — rebuilding it would reload the 12MB mesh and reset the camera on
     every colour change. Instead, when only the colour changes, we walk the
     already-loaded mesh group and swap each mesh's material. The GLB stays put,
     the camera stays put, and the cap actually updates. */
  const capMeshKey = render.capColourway
    ? `${render.capColourway.code}|${Object.entries(render.capColourway.meshes).map(([m, h]) => `${m}:${h}`).join(',')}`
    : '';
  useEffect(() => {
    const root = capRootRef.current;
    const meshes = render.capColourway?.meshes;
    if (!root || !meshes) return;
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const hex = meshes[mesh.name];
      if (!hex) return;                    // decoration/non-colour part — leave it
      mesh.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(`#${hex}`),
        roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capMeshKey]);

  /* A render for a DIFFERENT style than the one currently requested is stale —
     it belongs to the previous garment. Showing it while the caption names the
     new one is how the customer gets told they are looking at something they
     are not, so it is treated as "still loading" rather than displayed. */
  const stale = !!design.sku && !!render.style
    && render.style.trim().toUpperCase() !== design.sku.trim().toUpperCase();
  const view = stale ? 'loading' : status;

  /* Applying an edit writes to the SAME design state the agent reads, so the
     conversation and the garment can never drift apart. */
  const commitEdit = () => {
    if (!editing) return;
    dispatch({ type: 'SET_DESIGN', design: editing.key === 'teamName'
      ? { name: editing.value } : { number: editing.value } });
    setEditing(null);
  };

  /** Keep a popup anchored near the tap without letting it run off the panel. */
  /* Keep a popup fully on-screen: centre it on the tap, but never let it run
     past EITHER edge of the viewer. The old cap only guarded the left; a tap
     near the right edge pushed half the popup (and the name/number fields) off
     the panel, so it looked "cut in half" and was unusable. */
  const editingSafeX = (x: number, w = 208) => {
    const panelW = mountRef.current?.clientWidth ?? 800;
    return Math.max(8, Math.min(x - w / 2, panelW - w - 8));
  };

  /* Does this garment take a name or number at all?
   *
   * Answered from the style's captured lettering slots, not assumed: shorts and
   * accessories genuinely print nothing, and offering fields that cannot be
   * printed is the same failure as offering a design line the style does not
   * carry. Where the capture has not run we fall back to the measured text
   * zones, so a style that demonstrably letters is never reported as bare. */
  const canLetter = !!(render.letteringSlots?.length || render.textZones?.length);

  /* Who is on the stage, and what it costs (AUG-84).
   *
   * The panel used to be a bare canvas: at the moment of highest intent the
   * customer saw a garment and nothing else — no name, no price, no colours,
   * no next step, and no hint that clicking it does anything. Everything below
   * is already known to the app; it simply was not shown.
   *
   * Identity follows the style the server RENDERED, never the one requested, so
   * the strip can never name one garment while the viewer shows another — the
   * same rule the caption has always followed. */
  const shownSku = render.style || design.sku || '';
  const shownProduct = (state.recommendedProducts || []).find((p) => p.sku === shownSku);
  const shownName =
    shownProduct?.name
    || rack.flatMap((g) => g.items).find((i) => i.sku === shownSku)?.name
    || '';
  const shownPrice = typeof shownProduct?.price === 'number' ? shownProduct.price : null;
  const designLabel =
    render.designLines?.find((d) => d.slug === (render.appliedDesignLine || '').toLowerCase())?.label
    || render.appliedDesignLine
    || design.designLine
    || '';
  const inKit = kit.some((k: any) => k.sku === shownSku);
  /* Currency comes from the server's own pricing of this kit, so the panel can
     never label a figure in a symbol the quote does not use. */
  const money = (n: number) =>
    `${kitTotal?.symbol || '$'}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const muted = 'var(--text-muted,#888)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      {/* WHAT AM I LOOKING AT — name, design, colours, price. Rendered only once
          the server has told us which style is actually on the stage, so it
          never announces a garment that failed to load. */}
      {!!shownSku && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.25 }}>
              {shownName || 'Your garment'}
            </div>
            <div style={{ fontSize: 11.5, color: muted, marginTop: 2 }}>
              {[designLabel && `${designLabel} design`, `Style ${shownSku}`].filter(Boolean).join('  ·  ')}
            </div>
          </div>
          {!!colours.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {colours.map((name) => {
                const hex = inks[name];
                return (
                  <span key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: muted }}>
                    <span
                      title={hex ? `${name} ${hex}` : `${name} — shade not confirmed yet`}
                      style={{
                        width: 16, height: 16, borderRadius: 4, border: '1px solid var(--border)',
                        background: hex
                          // Hatched, never blank: an empty chip reads as broken.
                          || 'repeating-linear-gradient(45deg, var(--border) 0 3px, transparent 3px 6px)',
                      }}
                    />
                    {name}
                  </span>
                );
              })}
            </div>
          )}
          {shownPrice != null && (
            <div style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {money(shownPrice)} <span style={{ fontWeight: 400, color: muted }}>each</span>
            </div>
          )}
        </div>
      )}

      {/* The garment gets the room. Absolutely positioned so the canvas can
          never push the surrounding copy off screen. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative',
                    borderRadius: 14, overflow: 'hidden', background: 'var(--stage-bg, #fff)' }}>
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

        {/* THE RACK — top corner. What else can hang in this kit, grouped by the
            catalogue's own garment types. Not a curated "these go together"
            list, because for most styles we do not have that pairing data and
            inventing one would be a guess dressed as a recommendation. */}
        <button onClick={() => { setRackOpen((o) => !o); setVariants(null); setEditing(null); }}
                title="Your kit" aria-label="Your kit"
                style={{ position: 'absolute', top: 14, right: 14, zIndex: 6,
                         height: 40, borderRadius: 21, cursor: 'pointer',
                         display: 'flex', alignItems: 'center', gap: 8, padding: '0 15px 0 12px',
                         background: rackOpen ? 'var(--gold,#c41e3a)' : '#fff',
                         color: rackOpen ? 'var(--surface)' : 'var(--text)',
                         border: `1.5px solid ${rackOpen ? 'var(--gold,#c41e3a)' : 'rgba(0,0,0,.14)'}`,
                         font: '600 13px/1 var(--font-heading, sans-serif)',
                         boxShadow: '0 3px 14px rgba(0,0,0,.14)' }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
               stroke={rackOpen ? '#fff' : 'var(--gold,#c41e3a)'} strokeWidth="1.9" strokeLinecap="round">
            <path d="M3 6h18" />
            <path d="M7 6v3a2 2 0 0 0 2 2h1v8" /><path d="M17 6v3a2 2 0 0 1-2 2h-1v8" />
          </svg>
          <span>Your kit</span>
          {kit.length > 0 && (
            <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10,
                           display: 'grid', placeItems: 'center', fontSize: 11.5, fontWeight: 700,
                           background: rackOpen ? 'rgba(255,255,255,.25)' : 'var(--gold,#c41e3a)',
                           color: '#fff' }}>{kit.length}</span>
          )}
          {/* The running total, so the customer never has to open a quote to
              learn what the kit costs. Server-priced and roster-aware — this is
              the order value, not a unit price, and it is the same number the
              quote will show. */}
          {kitTotal && kit.length > 0 && (
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                           opacity: rackOpen ? 1 : 0.85 }}>
              {kitTotal.symbol}{kitTotal.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          )}
        </button>

        {rackOpen && (
          <div style={{ position: 'absolute', top: 54, right: 12, zIndex: 6, width: 244,
                        maxHeight: 'calc(100% - 70px)', overflowY: 'auto',
                        background: 'rgba(255,255,255,.97)', backdropFilter: 'blur(8px)',
                        border: '1px solid rgba(0,0,0,.08)', borderRadius: 12,
                        boxShadow: '0 12px 34px rgba(0,0,0,.16)', padding: 11 }}>

            {/* WHAT IS ON THE RACK. A kit is a top AND a bottom AND a cap, each
                keeping the design it was given — so this lists finished garments,
                not styles to jump between. Clicking one brings it back to the
                stage exactly as it was left. */}
            <div style={{ fontSize: 9, fontWeight: 700, color: '#999', letterSpacing: '.09em',
                          textTransform: 'uppercase', margin: '0 2px 7px' }}>
              Your kit · {kit.length} item{kit.length === 1 ? '' : 's'}
            </div>
            {!kit.length && (
              <div style={{ fontSize: 11, color: '#999', padding: '0 2px 10px', lineHeight: 1.5 }}>
                Nothing hung yet. Design a garment, then add it here to start building the kit.
              </div>
            )}
            {kit.map((k) => (
              <div key={k.sku}
                   style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 7px',
                            marginBottom: 4, borderRadius: 8, cursor: 'pointer',
                            border: `1px solid ${k.sku === design.sku ? 'var(--gold,#c41e3a)' : 'rgba(0,0,0,.08)'}`,
                            background: k.sku === design.sku ? 'rgba(196,30,58,.06)' : '#fff' }}
                   onClick={() => { dispatch({ type: 'LOAD_KIT_ITEM', sku: k.sku }); setRackOpen(false); }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#222' }}>{k.sku}</div>
                  <div style={{ fontSize: 9.5, color: '#888', whiteSpace: 'nowrap',
                                overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[k.garmentType, k.designLine, k.baseColor].filter(Boolean).join(' · ') || 'no design yet'}
                  </div>
                </div>
                <button title="Take off the rack"
                        onClick={(ev) => { ev.stopPropagation(); dispatch({ type: 'REMOVE_FROM_KIT', sku: k.sku }); }}
                        style={{ border: 'none', background: 'none', color: '#bbb',
                                 cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
            {/* Turn the kit into money.
                The rack never left the browser, so asking the agent to "quote
                what's in my rack" gave it nothing to price — it replied in prose
                and no quote appeared. This prices the rack directly: the styles
                and counts go to the quote engine, which owns every figure, and
                the result is shown straight away. The agent is told afterwards
                so the conversation stays in step. */}
            {kit.length > 0 && (
              <button
                disabled={pricing}
                onClick={async () => {
                  if (pricing) return;
                  setPricing(true);
                  setRackOpen(false);
                  try {
                    /* No quantity is sent: the roster size lives in the session,
                       and the server applies it. The browser must not invent a
                       number that ends up on an invoice. */
                    // Read the ACTIVE conversation's session — sessions are
                    // per thread, and the old project-wide key no longer
                    // exists, which silently cost the roster size and priced a
                    // team order as one of each.
                    const sessionId = activeSessionId(cfg.projectId);
                    const res = await fetch(
                      `/api/kit/quote?project=${encodeURIComponent(cfg.projectId || '')}`,
                      { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          items: kit.filter((k) => k?.sku).map((k) => ({ sku: k.sku })),
                          sessionId,
                          title: 'Team kit',
                        }) });
                    const d = await res.json();
                    if (d?.quote) {
                      dispatch({ type: 'SET_SERVER_QUOTE', quote: d.quote });
                      /* A note, not a message to the agent: asking it "what's
                         next?" made it re-list the products and the quote the
                         customer had just asked for vanished off the panel. */
                      const q = d.quote;
                      const each = q.lines?.[0]?.quantity;
                      dispatch({ type: 'ADD_MESSAGE', role: 'note',
                        text: `Priced your kit — ${q.lines?.length || 0} style${
                          (q.lines?.length || 0) === 1 ? '' : 's'}${
                          each > 1 ? `, ${each} of each` : ''}. Total ${q.symbol}${
                          (q.total || 0).toFixed(2)}.` });
                    }
                  } catch {
                    /* leave the rack as it was; the customer can try again */
                  } finally {
                    setPricing(false);
                  }
                }}
                style={{ width: '100%', marginTop: 8, padding: '9px 12px', fontSize: 12,
                         fontWeight: 700, letterSpacing: '.01em', color: 'var(--surface)',
                         background: 'var(--gold,#c41e3a)', border: 'none', borderRadius: 8,
                         cursor: 'pointer' }}>
                {pricing ? 'Pricing…' : `Build quote for ${kit.length} item${kit.length > 1 ? 's' : ''}`}{!pricing && kitTotal ? ` · ${kitTotal.symbol}${kitTotal.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ''} →
              </button>
            )}

            {/* Hang the garment currently on the stage. */}
            {design.sku && !kit.some((k) => k.sku === design.sku) && (
              <button onClick={() => dispatch({ type: 'ADD_TO_KIT', item: {
                        sku: design.sku!, garmentType: currentType, designLine: design.designLine,
                        baseColor: design.baseColor, accentColor: design.accentColor,
                        name: design.name, number: design.number,
                      } })}
                      style={{ width: '100%', marginTop: 4, marginBottom: 12, padding: '7px 0',
                               borderRadius: 7, border: 'none', cursor: 'pointer',
                               background: 'var(--gold,#c41e3a)', color: '#fff',
                               fontSize: 11, fontWeight: 700 }}>
                + Add this {currentType ? currentType.toLowerCase() : 'garment'} to the kit
              </button>
            )}

            {/* Add another piece. Grouped by the catalogue's own garment types,
                and a type already in the kit is marked so the customer can see
                what the kit still needs. */}
            <div style={{ fontSize: 9, fontWeight: 700, color: '#999', letterSpacing: '.09em',
                          textTransform: 'uppercase', margin: '4px 2px 7px',
                          borderTop: '1px solid rgba(0,0,0,.07)', paddingTop: 10 }}>
              Add a piece
            </div>
            {!rack.length && <div style={{ fontSize: 11, color: '#999', padding: 4 }}>Loading…</div>}
            {rack.map((g) => (
              <div key={g.type} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 9.5, fontWeight: 600, color: '#666', margin: '2px 4px 5px' }}>
                  {g.type}
                  {kit.some((k) => k.garmentType === g.type) && (
                    <span style={{ color: 'var(--gold,#c41e3a)', marginLeft: 5 }}>· in kit</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {g.items.map((it) => (
                    <button key={it.sku}
                            onClick={() => {
                              /* A different garment is a different design: its
                                 design lines and colour zones are its own. */
                              if (it.sku !== design.sku) dispatch({ type: 'CLEAR_DESIGN' });
                              dispatch({ type: 'SET_DESIGN', design: {
                                sku: it.sku, name: design.name, number: design.number } });
                              setRackOpen(false);
                            }}
                            title={it.name || it.sku}
                            style={{ padding: '5px 8px', borderRadius: 6, fontSize: 10.5, cursor: 'pointer',
                                     fontWeight: it.sku === design.sku ? 700 : 500,
                                     border: `1px solid ${it.sku === design.sku ? 'var(--gold,#c41e3a)' : 'rgba(0,0,0,.12)'}`,
                                     background: kit.some((k) => k.sku === it.sku) ? 'rgba(196,30,58,.06)' : '#fff',
                                     opacity: it.renderable ? 1 : 0.45, color: '#333' }}>
                      {it.sku}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tapping the garment: change anything about it.
         *
         * Name and number live HERE as well as on the garment itself. Clicking
         * the lettering directly is the nicer gesture, but it depends on the
         * measured text zones, and those are absent for every style right now —
         * so that path silently never fired and the customer could change the
         * design but could not type a name at all. A control that only works
         * when an upstream measurement happens to exist is not a control.
         *
         * So the garment tap always offers all three: design, colour, and
         * lettering. The direct-tap-on-the-name path still works where zones
         * exist; it is now an accelerator, not the only way in. */}
        {variants && (view === 'ready') && (
          /* Anchored to the tap, but never past the edge of the viewer.
           *
           * A style with 21 design lines makes this panel ~630px tall. Opened at
           * the tap point it ran 300px below the fold, so the name and number
           * fields existed and simply could not be reached — the control was
           * present and unusable, which is indistinguishable from missing. It is
           * therefore capped to the viewer's height, scrolls internally, and is
           * pulled back up when it would overflow. */
          <div style={{ position: 'absolute', zIndex: 6,
                        left: editingSafeX(variants.x, 208),
                        top: Math.max(8, Math.min(variants.y - 10,
                             (mountRef.current?.clientHeight ?? 600) - POPUP_MAX_H - 8)),
                        width: 208,
                        maxHeight: POPUP_MAX_H, overflowY: 'auto', overscrollBehavior: 'contain',
                        background: 'rgba(255,255,255,.97)', backdropFilter: 'blur(8px)',
                        border: '1px solid rgba(0,0,0,.08)', borderRadius: 12,
                        boxShadow: '0 12px 34px rgba(0,0,0,.16)', padding: 10 }}>
            {/* Lettering. Shown only when the style HAS somewhere to print it —
                a plain bottom or an accessory has no name or number, and
                offering fields that cannot be printed is the same lie as
                offering a design line the style does not carry (AUG-35). */}
            {canLetter && (
              <>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#999', letterSpacing: '.09em',
                              textTransform: 'uppercase', margin: '12px 2px 6px' }}>Name &amp; number</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    aria-label="Team name"
                    placeholder="Team name"
                    defaultValue={design.name || ''}
                    onBlur={(e) => dispatch({ type: 'SET_DESIGN', design: { name: e.target.value } })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, fontSize: 11,
                             border: '1px solid rgba(0,0,0,.14)', color: '#333' }} />
                  <input
                    aria-label="Number"
                    placeholder="No."
                    inputMode="numeric"
                    defaultValue={design.number || ''}
                    onBlur={(e) => dispatch({ type: 'SET_DESIGN', design: { number: e.target.value } })}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    style={{ width: 52, padding: '6px 8px', borderRadius: 6, fontSize: 11,
                             border: '1px solid rgba(0,0,0,.14)', color: '#333' }} />
                </div>
              </>
            )}

            {!!render.designLines?.length && (
              <>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#999', letterSpacing: '.09em',
                              textTransform: 'uppercase', margin: '0 2px 6px' }}>Design</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
                  {render.designLines.map((d) => (
                    <button key={d.slug}
                            onClick={() => dispatch({ type: 'SET_DESIGN', design: { designLine: d.slug } })}
                            style={{ padding: '5px 8px', borderRadius: 6, fontSize: 10.5, cursor: 'pointer',
                                     border: `1px solid ${d.slug === design.designLine ? 'var(--gold,#c41e3a)' : 'rgba(0,0,0,.12)'}`,
                                     background: d.slug === design.designLine ? 'rgba(196,30,58,.08)' : '#fff',
                                     color: '#333' }}>{d.label}</button>
                  ))}
                </div>
              </>
            )}
            {!!palette.length && (
              <>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#999', letterSpacing: '.09em',
                              textTransform: 'uppercase', margin: '0 2px 6px' }}>Colour</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {palette.map((c) => (
                    <button key={c}
                            onClick={() => dispatch({ type: 'SET_DESIGN', design: { baseColor: c } })}
                            style={{ padding: '4px 7px', borderRadius: 6, fontSize: 10, cursor: 'pointer',
                                     border: `1px solid ${c === design.baseColor ? 'var(--gold,#c41e3a)' : 'rgba(0,0,0,.12)'}`,
                                     background: c === design.baseColor ? 'rgba(196,30,58,.08)' : '#fff',
                                     color: '#444' }}>{c}</button>
                  ))}
                </div>
              </>
            )}

            <button onClick={() => setVariants(null)}
                    style={{ marginTop: 10, width: '100%', padding: '5px 0', borderRadius: 6,
                             border: '1px solid rgba(0,0,0,.10)', background: '#fafafa',
                             fontSize: 10.5, color: '#777', cursor: 'pointer' }}>Close</button>
          </div>
        )}

        {/* Edit the lettering where it lives. The field opens ON the garment at
            the point that was touched, so the customer is changing the thing
            they are looking at rather than describing it somewhere else. */}
        {editing && (
          <div style={{ position: 'absolute', left: editingSafeX(editing.x, 180),
                        top: Math.max(8, editing.y - 22), zIndex: 5,
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: 'rgba(12,12,12,.92)', backdropFilter: 'blur(6px)',
                        border: '1px solid rgba(255,255,255,.18)', borderRadius: 8,
                        padding: '6px 8px', boxShadow: '0 8px 28px rgba(0,0,0,.45)' }}>
            <input
              autoFocus
              value={editing.value}
              inputMode={editing.key === 'teamName' ? 'text' : 'numeric'}
              onChange={(e) => setEditing({ ...editing,
                value: editing.key === 'teamName' ? e.target.value : e.target.value.replace(/\D/g, '') })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEdit();
                if (e.key === 'Escape') setEditing(null);
              }}
              style={{ width: editing.key === 'teamName' ? 150 : 60, background: 'transparent',
                       border: 'none', outline: 'none', color: '#fff', fontSize: 13,
                       fontWeight: 600, letterSpacing: '.02em' }}
            />
            <button onClick={commitEdit} title="Apply"
                    style={{ border: 'none', borderRadius: 5, cursor: 'pointer',
                             background: 'var(--gold,#c41e3a)', color: '#fff',
                             fontSize: 11, fontWeight: 700, padding: '4px 9px' }}>
              Apply
            </button>
          </div>
        )}

        {/* No mesh for this style — show the print itself. It is the real
            artwork, just laid flat as the cut panels rather than worn. */}
        {view === 'flat' && render.texture && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={proxied(render.texture, project)} alt={`Print layout for style ${design.sku}`}
               style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                        objectFit: 'contain', padding: 12 }} />
        )}

        {/* No live preview for this style — show the real catalogue photograph
            rather than an empty panel with an explanation in it. */}
        {view === 'photo' && render.catalogueImage && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={render.catalogueImage} alt={`Catalogue photo, style ${design.sku}`}
               style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                        objectFit: 'contain', padding: 16 }} />
        )}

        {view !== 'ready' && view !== 'flat' && view !== 'photo' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                        background: 'var(--stage-bg, #fff)', fontSize: 13, color: muted,
                        textAlign: 'center', padding: 24, lineHeight: 1.6 }}>
            {view === 'loading' ? 'Building your garment…'
              : view === 'failed' ? detail
              : 'Tell me what you are making and it will appear here.'}
          </div>
        )}
      </div>

      {/* Honest reporting rather than a silent substitution: a colour the brand
          does not stock must never be quietly swapped for one it does. */}
      {!!render.rejectedColours?.length && (
        <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--warning)' }}>
          {`${render.rejectedColours.join(', ')} ${render.rejectedColours.length === 1 ? 'is not a colour' : 'are not colours'} `
           + `this brand stocks, so ${render.rejectedColours.length === 1 ? 'it was' : 'they were'} left off rather than `
           + 'swapped for something close. Ask me for the nearest match.'}
        </p>
      )}


      {/* When no design line was named the server applies the style's widest one
          so the colours are visible at all. Naming it keeps the caption honest —
          the customer is looking at a specific design, not a generic garment. */}
      {render.designLineDefaulted && render.appliedDesignLine && (
        <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {`Shown in the "${render.appliedDesignLine}" design — say the word and I'll switch it.`}
        </p>
      )}

      {/* WHAT DO I DO NOW (AUG-84).
          The one action that moves the journey forward lived inside the rack
          popup, two clicks away and invisible until you opened it, so the panel
          read as a picture with nothing to do. It belongs under the garment,
          next to what the kit currently costs. The hint is here because the
          garment IS clickable and nothing said so. */}
      {!!shownSku && status === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {inKit ? (
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
              ✓ In your kit
            </span>
          ) : (
            <button
              onClick={() => dispatch({ type: 'ADD_TO_KIT', item: {
                sku: shownSku, garmentType: currentType, designLine: design.designLine,
                baseColor: design.baseColor, accentColor: design.accentColor,
                name: design.name, number: design.number,
              } })}
              style={{ padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                       background: 'var(--gold,#c41e3a)', color: '#fff', fontSize: 12.5, fontWeight: 700 }}>
              Add this {currentType ? currentType.toLowerCase() : 'garment'} to the kit
            </button>
          )}
          {kitTotal && kit.length > 0 && (
            <span style={{ fontSize: 12, color: muted }}>
              {`Kit: ${kit.length} item${kit.length === 1 ? '' : 's'} · ${money(kitTotal.total)}`}
            </span>
          )}
          <span style={{ fontSize: 11.5, color: muted, marginLeft: 'auto' }}>
            Click the garment to change a colour or the lettering — or just tell me.
          </span>
        </div>
      )}
    </div>
  );
}
