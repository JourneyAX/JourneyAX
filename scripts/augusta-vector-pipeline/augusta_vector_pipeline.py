#!/usr/bin/env python3
"""Build a model-aligned, Illustrator-ready SVG from garment references.

The GLB is the 3D/UV authority. Reference photos provide artwork only. This
script deliberately does not invent manufacturing grading: one display-model
UV layout is not evidence for S/M/L/XL cut geometry.

Typical use from the JourneyAX repository root:

    apps/retexture-service/.venv/bin/python \
      scripts/augusta-vector-pipeline/augusta_vector_pipeline.py build \
      --style 228108 --design rinkster \
      --model /path/228108.glb \
      --front /path/rinkster-F.jpeg --back /path/rinkster-B.jpeg \
      --output-dir artifacts/rinkster-228108

The generated SVG is a concept/placement vector aligned to the GLB UV atlas.
It is not a sewing, cutting, or production-grading file until Augusta supplies
and approves the authoritative per-size Illustrator templates.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from scipy.ndimage import label
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from skimage.measure import approximate_polygon, find_contours


REPO_ROOT = Path(__file__).resolve().parents[2]
RETEXTURE_DIR = REPO_ROOT / "apps" / "retexture-service" / "py"


@dataclass(frozen=True)
class MeshInfo:
    name: str
    material: str
    vertices: np.ndarray
    faces: np.ndarray
    uv: np.ndarray


def run(args: list[str]) -> None:
    """Run one pipeline stage and surface its output on failure."""
    proc = subprocess.run(args, text=True, capture_output=True)
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.returncode:
        raise RuntimeError(proc.stderr.strip() or f"command failed: {args[0]}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_main_mesh(model: Path) -> MeshInfo:
    if not model.is_file():
        raise FileNotFoundError(model)
    if model.read_bytes()[:4] != b"glTF":
        raise ValueError(f"{model} is not a binary glTF/GLB")

    scene = trimesh.load(model, process=False)
    candidates: list[MeshInfo] = []
    for node in scene.graph.nodes_geometry:
        transform, geometry_name = scene.graph[node]
        geom = scene.geometry[geometry_name]
        uv = getattr(geom.visual, "uv", None)
        if uv is None:
            continue
        vertices = np.asarray(geom.vertices)
        vertices = vertices @ transform[:3, :3].T + transform[:3, 3]
        material = str(getattr(geom.visual.material, "name", "") or "")
        candidates.append(
            MeshInfo(
                name=geometry_name,
                material=material,
                vertices=vertices,
                faces=np.asarray(geom.faces),
                uv=np.asarray(uv),
            )
        )
    if not candidates:
        raise ValueError(f"{model} has no UV-mapped meshes")
    return next((m for m in candidates if m.material.lower() == "main"),
                max(candidates, key=lambda m: len(m.faces)))


def island_labels(mesh: MeshInfo) -> np.ndarray:
    faces = mesh.faces
    rows = np.concatenate([faces[:, 0], faces[:, 1], faces[:, 2]])
    cols = np.concatenate([faces[:, 1], faces[:, 2], faces[:, 0]])
    graph = coo_matrix((np.ones(len(rows)), (rows, cols)),
                       shape=(len(mesh.vertices), len(mesh.vertices)))
    _, labels = connected_components(graph, directed=False)
    return labels


def boundary_loops(mesh: MeshInfo, vertex_ids: set[int]) -> list[list[int]]:
    """Return ordered UV boundary loops for one connected mesh island."""
    edge_count: dict[tuple[int, int], int] = {}
    for face in mesh.faces:
        if int(face[0]) not in vertex_ids:
            continue
        for a, b in ((int(face[0]), int(face[1])),
                     (int(face[1]), int(face[2])),
                     (int(face[2]), int(face[0]))):
            edge = (min(a, b), max(a, b))
            edge_count[edge] = edge_count.get(edge, 0) + 1
    edges = [edge for edge, count in edge_count.items() if count == 1]
    adjacency: dict[int, list[int]] = {}
    for a, b in edges:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)

    unused = {tuple(sorted(edge)) for edge in edges}
    loops: list[list[int]] = []
    while unused:
        first = next(iter(unused))
        start, current = first
        loop = [start]
        previous: int | None = None
        while True:
            loop.append(current)
            unused.discard(tuple(sorted((loop[-2], current))))
            choices = [v for v in adjacency.get(current, []) if v != previous]
            next_vertex = next(
                (v for v in choices if tuple(sorted((current, v))) in unused),
                choices[0] if choices else start,
            )
            previous, current = current, next_vertex
            if current == start or len(loop) > len(edges) + 2:
                break
        if len(loop) >= 4:
            loops.append(loop)
    return loops


def svg_cut_paths(mesh: MeshInfo, width: int, height: int) -> list[dict]:
    labels = island_labels(mesh)
    islands = []
    for island_id in range(int(labels.max()) + 1):
        ids = set(np.where(labels == island_id)[0].tolist())
        selected = labels[mesh.faces[:, 0]] == island_id
        face_count = int(np.sum(selected))
        if face_count < 4:
            continue
        # Extracting ordered topological boundary loops from a garment mesh can
        # explode on non-manifold seam vertices. Rasterizing each island first
        # is bounded by atlas resolution, matches the placement atlas exactly,
        # and still gives Illustrator a clean vector cut-line path.
        image = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(image)
        for face in mesh.faces[selected]:
            draw.polygon([
                (float(mesh.uv[i, 0]) * (width - 1),
                 (1.0 - float(mesh.uv[i, 1])) * (height - 1))
                for i in face
            ], fill=255)
        path = contour_path(np.asarray(image) > 0, tolerance=0.7, minimum_area=3)
        if path:
            uv = mesh.uv[list(ids)]
            xyz = mesh.vertices[list(ids)]
            islands.append({
                "id": island_id,
                "faces": face_count,
                "path": path,
                "uvBounds": [uv.min(0).round(6).tolist(), uv.max(0).round(6).tolist()],
                "centroid3d": xyz.mean(0).round(6).tolist(),
            })
    return islands


def uv_mask(mesh: MeshInfo, width: int, height: int) -> np.ndarray:
    image = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(image)
    uv = mesh.uv
    for face in mesh.faces:
        points = [
            (float(uv[i, 0]) * (width - 1),
             (1.0 - float(uv[i, 1])) * (height - 1))
            for i in face
        ]
        draw.polygon(points, fill=255)
    return np.asarray(image) > 0


def drop_small_regions(mask: np.ndarray, minimum_area: int) -> np.ndarray:
    regions, count = label(mask)
    if not count:
        return mask
    sizes = np.bincount(regions.ravel())
    keep = sizes >= minimum_area
    keep[0] = False
    return keep[regions]


def contour_path(mask: np.ndarray, tolerance: float, minimum_area: int) -> str:
    cleaned = drop_small_regions(mask, minimum_area)
    padded = np.pad(cleaned, 1)
    commands: list[str] = []
    for contour in find_contours(padded.astype(float), 0.5,
                                 fully_connected="high"):
        points = approximate_polygon(contour[:, ::-1] - 1, tolerance=tolerance)
        if len(points) < 4:
            continue
        commands.append("M " + " L ".join(
            f"{x:.2f},{y:.2f}" for x, y in points
        ) + " Z")
    return " ".join(commands)


def quantized_layers(atlas: Image.Image, coverage: np.ndarray,
                     colors: int, minimum_area: int) -> list[dict]:
    rgba = atlas.convert("RGBA")
    pixels = np.asarray(rgba).copy()
    pixels[~coverage, 3] = 0
    quantized = Image.fromarray(pixels).quantize(
        colors=max(2, colors), method=Image.Quantize.FASTOCTREE
    )
    indices = np.asarray(quantized)
    decoded = np.asarray(quantized.convert("RGBA"))
    layers = []
    for index in np.unique(indices[coverage]):
        region = (indices == index) & coverage
        path = contour_path(region, tolerance=1.35, minimum_area=minimum_area)
        if not path:
            continue
        rgba_value = decoded[region][0]
        layers.append({
            "index": int(index),
            "fill": f"#{rgba_value[0]:02X}{rgba_value[1]:02X}{rgba_value[2]:02X}",
            "pixels": int(region.sum()),
            "path": path,
        })
    return sorted(layers, key=lambda item: item["pixels"], reverse=True)


def write_svg(*, atlas_path: Path, model_path: Path, output_path: Path,
              style: str, design: str, source_front: str | None,
              source_back: str | None, colors: int, minimum_area: int) -> dict:
    atlas = Image.open(atlas_path).convert("RGB")
    mesh = load_main_mesh(model_path)
    width, height = atlas.size
    coverage = uv_mask(mesh, width, height)
    layers = quantized_layers(atlas, coverage, colors, minimum_area)
    islands = svg_cut_paths(mesh, width, height)
    metadata = {
        "schema": "journeyax.augusta.vector-placement.v1",
        "style": style,
        "design": design,
        "model": str(model_path),
        "mesh": mesh.name,
        "material": mesh.material,
        "frontReference": source_front,
        "backReference": source_back,
        "classification": "3D UV placement / concept vector",
        "productionStatus": "REQUIRES_AUGUSTA_ART_AND_GRADED_TEMPLATE_APPROVAL",
        "warning": "Do not use as a sewing/cutting pattern or infer other sizes by scaling.",
        "islands": [{k: v for k, v in island.items() if k != "path"}
                    for island in islands],
    }
    art = "\n".join(
        f'    <path id="color-{layer["index"]}" fill="{layer["fill"]}" '
        f'fill-rule="evenodd" d="{layer["path"]}"/>'
        for layer in layers
    )
    cuts = "\n".join(
        f'    <path id="uv-island-{island["id"]}" d="{island["path"]}"/>'
        for island in islands
    )
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}px" height="{height}px"
     viewBox="0 0 {width} {height}" data-style="{html.escape(style)}"
     data-design="{html.escape(design)}" data-production-approved="false">
  <title>{html.escape(design)} — Augusta {html.escape(style)} UV placement vector</title>
  <desc>Editable concept vector aligned to the official 3D model UV layout. Not a graded manufacturing pattern.</desc>
  <metadata>{html.escape(json.dumps(metadata, separators=(",", ":")))}</metadata>
  <g id="ARTWORK" data-layer="editable-color-regions">
{art}
  </g>
  <g id="UV_CUT_LINES" fill="none" stroke="#00AEEF" stroke-width="1"
     stroke-linejoin="round" vector-effect="non-scaling-stroke">
{cuts}
  </g>
  <g id="PRODUCTION_WARNING" display="none">
    <text x="24" y="42" font-family="Arial" font-size="24" fill="#D71920">CONCEPT UV PLACEMENT — NOT A GRADED CUT PATTERN</text>
  </g>
</svg>
'''
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(svg, encoding="utf-8")
    return {
        "svg": str(output_path),
        "width": width,
        "height": height,
        "colors": len(layers),
        "uvIslands": len(islands),
        "mesh": mesh.name,
        "material": mesh.material,
    }


def parse_sizes(value: str) -> list[str]:
    return [item.strip().upper() for item in value.split(",") if item.strip()]


def write_manifest(*, output_dir: Path, style: str, design: str,
                   model: Path, front: Path | None, back: Path | None,
                   outputs: dict, sizes: list[str]) -> Path:
    files = [Path(outputs["svg"])]
    for key in ("atlas", "glb", "preview"):
        value = outputs.get(key)
        if value:
            files.append(Path(value))
    portable_outputs = dict(outputs)
    for key in ("svg", "atlas", "glb", "preview"):
        value = portable_outputs.get(key)
        if not value:
            continue
        path_value = Path(value).resolve()
        try:
            portable_outputs[key] = str(path_value.relative_to(output_dir.resolve()))
        except ValueError:
            portable_outputs[key] = str(path_value)
    try:
        portable_model = str(model.resolve().relative_to(output_dir.resolve()))
    except ValueError:
        portable_model = os.path.relpath(model.resolve(), output_dir.resolve())
    manifest = {
        "schema": "journeyax.augusta.asset-package.v1",
        "style": style,
        "design": design,
        "source": {
            "model": portable_model,
            "front": str(front) if front else None,
            "back": str(back) if back else None,
        },
        "outputs": portable_outputs,
        "sizes": [{
            "size": size,
            "placementSvg": Path(outputs["svg"]).name,
            "threeDPreview": Path(outputs["preview"]).name if outputs.get("preview") else None,
            "manufacturingTemplate": None,
            "status": "BLOCKED_PENDING_AUTHORITATIVE_GRADED_TEMPLATE",
        } for size in sizes],
        "approvals": {
            "garmentConstruction": "required",
            "artReconstruction": "required",
            "trademarkAndLogoRights": "required",
            "colorStandard": "required",
            "seamAndBleed": "required",
            "perSizeGrading": "required",
            "productionProof": "required",
        },
        "checksums": {path.name: sha256(path) for path in files if path.is_file()},
    }
    path = output_dir / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    return path


def vectorize_command(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    svg_path = output_dir / f"{args.design}-{args.style}-uv-placement.svg"
    outputs = write_svg(
        atlas_path=Path(args.atlas).resolve(),
        model_path=Path(args.model).resolve(),
        output_path=svg_path,
        style=args.style,
        design=args.design,
        source_front=args.front,
        source_back=args.back,
        colors=args.colors,
        minimum_area=args.minimum_area,
    )
    for key in ("atlas", "glb", "preview"):
        value = getattr(args, key, None)
        if value:
            outputs[key] = str(Path(value).resolve())
    manifest = write_manifest(
        output_dir=output_dir,
        style=args.style,
        design=args.design,
        model=Path(args.model).resolve(),
        front=Path(args.front).resolve() if args.front else None,
        back=Path(args.back).resolve() if args.back else None,
        outputs=outputs,
        sizes=parse_sizes(args.sizes),
    )
    print(json.dumps({"ok": True, **outputs, "manifest": str(manifest)}, indent=2))


def build_command(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    model = Path(args.model).resolve()
    front = Path(args.front).resolve()
    back = Path(args.back).resolve() if args.back else None
    load_main_mesh(model)  # fail before spending time on imaging

    prepared_front = output_dir / "reference-front-cutout.png"
    run([sys.executable, str(RETEXTURE_DIR / "prep.py"), "--in", str(front),
         "--out", str(prepared_front), "--no-rembg"])
    prepared_back = None
    if back:
        prepared_back = output_dir / "reference-back-cutout.png"
        run([sys.executable, str(RETEXTURE_DIR / "prep.py"), "--in", str(back),
             "--out", str(prepared_back), "--no-rembg"])

    glb_path = output_dir / f"{args.design}-{args.style}-preview.glb"
    bake_args = [
        sys.executable, str(RETEXTURE_DIR / "retexture.py"),
        "--glb", str(model),
        "--view", f"front:{prepared_front}",
        "--out", str(glb_path),
        "--size", str(args.atlas_size),
        "--colors", str(args.colors),
        "--preview",
    ]
    if prepared_back:
        bake_args[4:4] = ["--view", f"back:{prepared_back}"]
    run(bake_args)

    atlas_path = glb_path.with_suffix(".png")
    preview_path = glb_path.with_suffix(".preview.png")
    svg_path = output_dir / f"{args.design}-{args.style}-uv-placement.svg"
    outputs = write_svg(
        atlas_path=atlas_path,
        model_path=model,
        output_path=svg_path,
        style=args.style,
        design=args.design,
        source_front=str(front),
        source_back=str(back) if back else None,
        colors=args.colors,
        minimum_area=args.minimum_area,
    )
    outputs.update(atlas=str(atlas_path), glb=str(glb_path), preview=str(preview_path))
    manifest = write_manifest(
        output_dir=output_dir,
        style=args.style,
        design=args.design,
        model=model,
        front=front,
        back=back,
        outputs=outputs,
        sizes=parse_sizes(args.sizes),
    )
    print(json.dumps({"ok": True, **outputs, "manifest": str(manifest)}, indent=2))


def add_common(parser: argparse.ArgumentParser, *, require_front: bool = False) -> None:
    parser.add_argument("--style", required=True)
    parser.add_argument("--design", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--front", required=require_front)
    parser.add_argument("--back")
    parser.add_argument("--colors", type=int, default=12)
    parser.add_argument("--minimum-area", type=int, default=8)
    parser.add_argument("--sizes", default="S,M,L,XL,2XL,3XL,GM,G2XL")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="reference photos -> atlas + GLB + SVG")
    add_common(build, require_front=True)
    build.add_argument("--atlas-size", type=int, default=1400)
    build.set_defaults(handler=build_command)

    vectorize = sub.add_parser("vectorize", help="existing baked atlas -> SVG")
    add_common(vectorize)
    vectorize.add_argument("--atlas", required=True)
    vectorize.add_argument("--glb")
    vectorize.add_argument("--preview")
    vectorize.set_defaults(handler=vectorize_command)

    args = parser.parse_args()
    try:
        args.handler(args)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
