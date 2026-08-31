#!/usr/bin/env python3
"""Render a five-angle contact sheet from an already textured GLB.

This intentionally reuses the CPU rasterizer in the sibling
``3d-garment-retexture`` project. It does not rebake or reinterpret the
artwork; it only verifies that an exported texture is mapped correctly.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np


def renderer_path() -> Path:
    journeyax_root = Path(__file__).resolve().parents[2]
    return journeyax_root.parent / "3d-garment-retexture" / "py"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--width", type=int, default=420)
    parser.add_argument("--height", type=int, default=520)
    args = parser.parse_args()

    support = renderer_path()
    if not support.exists():
        raise SystemExit(f"Renderer support directory not found: {support}")
    sys.path.insert(0, str(support))

    from retexture import flat_colour, load_glb, preview  # noqa: PLC0415

    _, meshes = load_glb(args.glb)
    if not meshes:
        raise SystemExit(f"No UV-mapped meshes found in {args.glb}")

    draws = []
    textured = []
    for name, mesh in meshes.items():
        material = getattr(mesh["geom"].visual, "material", None)
        image = getattr(material, "baseColorTexture", None)
        texture = None
        if image is not None:
            texture = np.asarray(image.convert("RGB"))
            textured.append(name)
        draws.append((mesh, texture, flat_colour(mesh["geom"])))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    preview(draws, args.out, size=(args.width, args.height))
    triangles = sum(len(mesh["F"]) for mesh in meshes.values())
    print(
        f"wrote {args.out} | meshes={len(meshes)} | triangles={triangles} "
        f"| textured={','.join(textured) or 'none'}"
    )


if __name__ == "__main__":
    main()
