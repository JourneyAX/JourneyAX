"""retexture-service — bakes a customer design onto the real per-SKU 3D mesh.

    POST /retexture   { glb, front, back?, tier?, size?, backText?, projectId? }
      -> renders the mesh, Gemini-paints each view onto its own silhouette,
         bakes into a UV atlas, returns diagnostics + downloadable GLB/atlas/preview.
    GET  /health

Inputs (glb / front / back) each accept ONE of: {base64}, {url}, {path}.
Keeps the geometry in Python (trimesh/scipy/rembg) — this is what Python is for.
"""
from __future__ import annotations

import base64
import os
import sys
import uuid
from pathlib import Path

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .pipeline import run_pipeline

PORT = int(os.environ.get("PORT") or os.environ.get("RETEXTURE_SERVICE_PORT") or 8091)
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
DATA_DIR = Path(os.environ.get("RETEXTURE_DATA_DIR") or (Path(__file__).resolve().parent.parent / "data"))
JOBS_DIR = DATA_DIR / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="retexture-service", version="0.1.0")
# The browser's Three.js GLTFLoader fetches the baked GLB + atlas directly,
# cross-origin from the storefront — so the job assets need permissive CORS,
# exactly like the momentec model CDN (access-control-allow-origin: *). These
# are public design previews keyed by an unguessable job id.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
)
app.mount("/jobs", StaticFiles(directory=str(JOBS_DIR)), name="jobs")


class ImageInput(BaseModel):
    base64: str | None = None
    url: str | None = None
    path: str | None = None


class RetextureRequest(BaseModel):
    glb: ImageInput
    front: ImageInput
    back: ImageInput | None = None
    tier: str = "quality"          # 'quality' | 'fast'
    size: int = 4096
    backText: str | None = None
    # Paint the back from the front reference as PATTERN-ONLY (no lettering), so
    # a roster's per-player name/number can be overlaid client-side on one bake.
    paintBack: bool = False
    # Paint the left + right flanks/sleeves from the front reference (pattern only)
    # so the sides don't get filled by projection spill.
    paintSides: bool = False
    projectId: str | None = None


def _guard(x_internal_key: str | None):
    if INTERNAL_API_KEY and x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=401, detail="bad internal key")


def _materialise(inp: ImageInput, dst: Path) -> str:
    """Resolve a base64/url/path input to a real file on disk; return its path."""
    if inp.path:
        if not Path(inp.path).exists():
            raise HTTPException(400, f"path not found: {inp.path}")
        return inp.path
    if inp.base64:
        raw = inp.base64.split(",", 1)[-1]  # tolerate data: URLs
        dst.write_bytes(base64.b64decode(raw))
        return str(dst)
    if inp.url:
        r = requests.get(inp.url, timeout=60)
        r.raise_for_status()
        dst.write_bytes(r.content)
        return str(dst)
    raise HTTPException(400, "each input needs one of base64 | url | path")


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "retexture-service",
        "geminiKey": bool(GEMINI_API_KEY),
        "python": sys.version.split()[0],
    }


@app.post("/retexture")
def retexture(req: RetextureRequest, x_internal_key: str | None = Header(default=None)):
    _guard(x_internal_key)
    if not GEMINI_API_KEY:
        raise HTTPException(503, "GEMINI_API_KEY not configured")

    job_id = uuid.uuid4().hex[:12]
    work = JOBS_DIR / job_id
    work.mkdir(parents=True, exist_ok=True)
    log_lines: list[str] = []

    try:
        glb_path = _materialise(req.glb, work / "mesh.glb")
        refs = {"front": _materialise(req.front, work / "in.front.png")}
        if req.back:
            refs["back"] = _materialise(req.back, work / "in.back.png")

        result = run_pipeline(
            work_dir=work, glb_path=glb_path, refs=refs,
            api_key=GEMINI_API_KEY, tier=req.tier, size=req.size,
            back_text=req.backText, paint_back=req.paintBack, paint_sides=req.paintSides,
            python_bin=sys.executable, log=log_lines.append,
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e), "log": log_lines[-30:]})

    base = f"/jobs/{job_id}"
    return {
        "ok": True,
        "jobId": job_id,
        "diagnostics": result["diagnostics"],
        "glbUrl": f"{base}/retextured.glb",
        "atlasUrl": f"{base}/retextured.png",
        "previewUrl": f"{base}/retextured.preview.png",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
