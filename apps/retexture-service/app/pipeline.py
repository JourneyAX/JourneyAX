"""Retexture orchestration — Python port of the teammate's pipeline.js, extended
with per-view references (front<-F, back<-B). One language end to end:

    prep  ->  render_views  ->  gemini paint (per view)  ->  retexture bake

The render is the shape authority; the reference is the design source. The bake
locks each painted view to its render (IoU) and falls back to axis-fit on drift.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from .gemini import paint_views

PY_DIR = Path(__file__).resolve().parent.parent / "py"


def _run(python_bin: str, args: list[str], cwd: Path, log=None) -> str:
    proc = subprocess.Popen(
        [python_bin, *args], cwd=str(cwd),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    out_lines, err_lines = [], []
    assert proc.stdout and proc.stderr
    for line in proc.stdout:
        out_lines.append(line)
        if log:
            log(line.rstrip())
    err_lines = proc.stderr.read().splitlines()
    code = proc.wait()
    if code != 0:
        raise RuntimeError("\n".join(err_lines[-4:]) or f"exit {code}")
    return "".join(out_lines)


def parse_diagnostics(stdout: str) -> dict:
    stats: dict = {"views": [], "palette": [], "warnings": []}
    pending = None
    for line in stdout.split("\n"):
        if (m := re.match(r"^\s{2}(\w+):\s+(.+?)\s+(\d+)x(\d+)\s*$", line)):
            pending = {"view": m.group(1), "file": m.group(2)}
        elif (m := re.search(r"silhouette IoU\s+([\d.]+)", line)):
            stats["views"].append({
                **(pending or {"view": "?"}),
                "iou": float(m.group(1)),
                "locked": "camera locked" in line,
            })
            pending = None
        elif (m := re.search(r"coverage:\s+([\d.]+)%", line)):
            stats["coverage"] = float(m.group(1))
        elif (m := re.match(r"^mesh (\S+): (\d+) tris, (\d+) verts", line)):
            stats["mesh"] = {"name": m.group(1), "tris": int(m.group(2)), "verts": int(m.group(3))}
        elif (m := re.match(r"^UV islands:\s+(\d+)", line)):
            stats["islands"] = int(m.group(1))
        elif (m := re.match(r"^atlas (\d+)x(\d+)", line)):
            stats["atlas"] = f"{m.group(1)}x{m.group(2)}"
        elif (m := re.search(r"rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\)\s+([\d.]+)%", line)):
            r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            stats["palette"].append({
                "rgb": [r, g, b],
                "hex": f"#{r:02x}{g:02x}{b:02x}",
                "share": float(m.group(4)),
            })
        elif (m := re.search(r"island\s+(\d+):.*->\s+keeps pixels", line)):
            stats.setdefault("keepIslands", []).append(int(m.group(1)))
        elif "WARNING" in line:
            stats["warnings"].append(line.strip())

    ious = [v["iou"] for v in stats["views"]]
    worst = min(ious) if ious else None
    stats["verdict"] = (
        "unknown" if worst is None
        else "good" if worst >= 0.85
        else "usable" if worst >= 0.75
        else "poor"
    )
    return stats


def run_pipeline(*, work_dir: Path, glb_path: str, refs: dict[str, str],
                 api_key: str, tier: str = "quality", size: int = 4096,
                 colors: int = 6, back_text: str | None = None,
                 paint_back: bool = False, paint_sides: bool = False,
                 min_facing: float = 0.0,
                 python_bin: str = sys.executable, log=None) -> dict:
    """refs: {view -> reference-image path}. At least 'front' is expected.
    Returns {ok, glb, atlas, preview, diagnostics} with absolute output paths."""
    work_dir.mkdir(parents=True, exist_ok=True)
    _log = log or (lambda *_: None)
    refs = dict(refs)
    # A single uploaded design is a FRONT reference. To also dress the back from
    # it, reuse the front reference for the back view: the back paint rule tells
    # Gemini NOT to copy the front logo but to continue the colour blocking and
    # pattern. If `back_text` is given it is placed on the upper back; if not, the
    # back is pattern-only — the intended path when the name/number is overlaid
    # per player from a roster (so ONE bake dresses a whole squad). Triggered by
    # either back_text (bake the lettering) or paint_back (pattern-only back).
    if "back" not in refs and (back_text or paint_back) and "front" in refs:
        refs["back"] = refs["front"]
        _log("  back view will continue the front pattern"
             + (" + place the back lettering" if back_text else " (pattern only; lettering overlaid per player)"))
    # SIDES: without a painted left/right source the flanks + sleeves get filled
    # by projection spill (streaky white artefacts in the atlas). Reuse the front
    # reference for the side views — the left/right paint rule keeps only the
    # colour blocking / stripes / pattern flow and places NO logo / name / number,
    # so the pattern continues cleanly onto the sleeves. (Explicit left/right refs
    # from a 4-side upload win — they're already in refs and not overwritten.)
    if paint_sides and "front" in refs:
        for side in ("left", "right"):
            if side not in refs:
                refs[side] = refs["front"]
        _log("  left + right views will continue the front pattern onto the flanks/sleeves")
    views_wanted = [v for v in ("front", "back", "left", "right") if v in refs]

    # 1. cut each reference out of its background
    cut: dict[str, str] = {}
    for v in views_wanted:
        dst = work_dir / f"ref.{v}.png"
        _run(python_bin, [str(PY_DIR / "prep.py"), "--in", refs[v], "--out", str(dst)], work_dir, _log)
        cut[v] = str(dst)

    # 2. render the mesh from those axes (the shape authority)
    _run(python_bin, [str(PY_DIR / "render_views.py"), "--glb", glb_path,
                      "--out-dir", str(work_dir), "--views", ",".join(views_wanted)], work_dir, _log)
    cams_path = work_dir / "cams.json"
    cams = json.loads(cams_path.read_text())

    # 3. paint each render with ITS OWN reference
    view_args: list[str] = []
    for v in views_wanted:
        render_path = str(work_dir / cams["views"][v]["render"])
        painted = paint_views(api_key, cut[v], {v: render_path},
                              tier=tier, back_text=back_text, log=_log)
        if v not in painted:
            _log(f"!! {v} paint failed, skipping")
            continue
        raw = work_dir / f"{v}.raw.png"
        raw.write_bytes(painted[v])
        clean = work_dir / f"{v}.painted.png"
        full = work_dir / f"{v}.full.png"
        _run(python_bin, [str(PY_DIR / "prep.py"), "--in", str(raw),
                          "--out", str(clean), "--full", str(full)], work_dir, _log)
        cams["views"][v]["painted"] = full.name
        view_args.append(f"{v}:{full}")
    cams_path.write_text(json.dumps(cams, indent=2))

    if not view_args:
        raise RuntimeError("no views survived painting")

    # 4. bake all painted views into the atlas.
    # min-facing: drop texels no view ever caught square-on. With side views this
    # matters — a back-shoulder/seam texel is only ever GRAZED by a side view, so
    # its front-design paint smears across the back (the orange chevron down the
    # spine). Dropping those texels lets the hole fill from a neighbouring panel
    # (reads as fabric) instead. Off for a front/back-only bake (nothing grazes),
    # on when painting sides. Author's own knob for exactly this artefact.
    mf = min_facing if min_facing > 0 else (0.25 if paint_sides else 0.0)
    out_glb = work_dir / "retextured.glb"
    args = [str(PY_DIR / "retexture.py"), "--glb", glb_path, "--out", str(out_glb),
            "--size", str(size), "--colors", str(colors), "--preview", "--cams", str(cams_path)]
    if mf > 0:
        args += ["--min-facing", str(mf)]
    for va in view_args:
        args += ["--view", va]
    stdout = _run(python_bin, args, work_dir, _log)

    return {
        "ok": True,
        "glb": str(out_glb),
        "atlas": str(work_dir / "retextured.png"),
        "preview": str(work_dir / "retextured.preview.png"),
        "diagnostics": parse_diagnostics(stdout),
    }
