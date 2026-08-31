# retexture-service

Bakes a customer's custom design onto the **real per-SKU 3D mesh**. Given a `.glb`
and one or more design references (front, back), it renders the mesh from each
axis, has Gemini paint the design onto each *silhouette* (the render is the shape
authority, the reference is only the design source), then back-projects and bakes
the painted views into a single UV atlas — producing a `retextured.glb` that wraps
the design correctly around collar, hem and sleeves.

This is the productionised form of the P0 CLI proof (NORTH VIEW + RINKSTER baked
onto `228103.glb`). It is **Python on purpose**: the geometry core (trimesh,
scipy, rembg, scikit-learn) is scientific Python and is vendored unchanged under
`py/`. The Node orchestration + Gemini paint were ported to Python so the whole
service is one language with no Node dependency.

## Why a separate service (not in product-service)

The rest of the platform is TypeScript ("No Python" rule). The mesh bake genuinely
needs the Python scientific stack; rewriting `retexture.py`'s camera-fit /
back-projection in Node would be a large, bug-prone port for no benefit. So it
lives behind an HTTP boundary and `product-service` calls it (P2).

## Layout

```
app/
  main.py       FastAPI: /health, POST /retexture  (serves outputs at /jobs/<id>/…)
  pipeline.py   orchestration: prep -> render_views -> gemini paint -> retexture bake
  gemini.py     per-view paint (Gemini 3 pro/flash image), faithful port of gemini.js
py/             vendored geometry core (unchanged from the reference repo)
  prep.py         cut the garment out of a reference (rembg / brightness)
  render_views.py photograph the mesh per axis -> render + mask + cams.json
  retexture.py    back-project painted views into a UV atlas; camera lock + diagnostics
```

## Run

```bash
cd apps/retexture-service
npm run setup                 # python3.12 venv + deps (scipy/onnxruntime/rembg — a few min)
GEMINI_API_KEY=... npm run dev # uvicorn on :8091 (--reload)
```

Env: `PORT` (default 8091), `GEMINI_API_KEY` (required for /retexture),
`INTERNAL_API_KEY` (if set, callers must send `X-Internal-Key`),
`RETEXTURE_DATA_DIR` (job output root, default `./data`).

## API

`POST /retexture`
```jsonc
{
  "glb":   { "url|base64|path": "…" },   // the base mesh
  "front": { "url|base64|path": "…" },   // required design reference
  "back":  { "url|base64|path": "…" },   // optional
  "tier":  "quality",                     // 'quality' | 'fast'
  "size":  4096,                          // atlas edge
  "backText": "NORTH VIEW\n25",           // optional back lettering hint
  "projectId": "augusta"
}
```
→
```jsonc
{
  "ok": true,
  "jobId": "…",
  "diagnostics": { "mesh": {…}, "atlas": "4096x4096", "coverage": 90.1,
                   "views": [{ "view": "front", "iou": 0.95, "locked": true }],
                   "palette": [{ "rgb": […], "hex": "#1f1c1b", "share": 51.7 }],
                   "verdict": "good", "warnings": [] },
  "glbUrl": "/jobs/<id>/retextured.glb",
  "atlasUrl": "/jobs/<id>/retextured.png",
  "previewUrl": "/jobs/<id>/retextured.preview.png"
}
```

`GET /health` → `{ ok, geminiKey, python }`.

## Deploy (Cloud Run)

Rides the shared 4-step Cloud Build pipeline (`scripts/cloudbuild-*.sh`) with its
own `Dockerfile` (Python, not the Node `Dockerfile.template`). It's in `ALL_SVCS`,
gets 2 vCPU / 2Gi / 900s / concurrency 1 / scale-to-zero, is public (the browser
loads the baked GLB from `/jobs/<id>/…`), and `update-urls` injects
`RETEXTURE_SERVICE_URL` into product-service. Full notes + UAT caveats (ephemeral
`/jobs` → GCS for prod; route `bake3d` via the gateway) in
[`docs/deployment-plan.md` §retexture](../../docs/deployment-plan.md).

Sanity-build the image on a Docker host before the first cloud deploy:
```bash
docker build -f apps/retexture-service/Dockerfile apps/retexture-service
```
