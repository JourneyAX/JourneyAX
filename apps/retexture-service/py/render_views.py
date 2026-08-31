#!/usr/bin/env python3
"""render_views.py - photograph the GLB itself, from the axes the bake will use.

    python render_views.py --glb shirt.glb --out-dir work/abc --views front,back,left,right

Writes, per view:

    render.<view>.png        shaded grey on white  -- what Gemini is shown
    render.<view>.mask.png   the exact silhouette  -- what the bake trusts

and one cams.json describing the frames, so retexture.py can skip fitting a
camera and use the one the render was made with.

Why this exists: Gemini used to invent the garment's shape from a photograph,
and retexture.py then tried to match that invention to the model with a rigid
silhouette fit. When the photo's garment differed from the model's -- a
different cut, a different crop, a different sleeve -- there was no fit to
find. Rendering the model first makes the model the shape authority and
demotes the reference to what it should always have been: a source of design.

No GPU, no Blender, no browser. This reuses retexture.py's rasterizer so the
frames are identical by construction rather than by agreement.
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
from PIL import Image

from retexture import (VIEWS, load_glb, pick_mesh, silhouette, project,
                       identity_cam)

# Mid grey. Dark enough to separate from the white background at the
# silhouette edge, light enough that the shading gradient stays readable.
BASE = np.array([190.0, 190.0, 194.0])


def render(m, view_dir, res, pad):
    """Shaded render + exact silhouette, both in the frame's own pixel space."""
    _, frame = silhouette(m['V'], m['F'], view_dir, res=res, pad=pad)
    pts = project(m['V'], frame, identity_cam(res))

    cover, _, out = _shade_raster(m, pts, frame, res)
    if not cover.any():
        return None, None, frame

    img = np.full((res, res, 3), 255.0, np.float32)
    ys, xs = np.where(cover)
    n = out['n'][ys, xs]
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    # Lambert against the view axis. Enough to read sleeves, shoulders and the
    # body as separate forms without implying a light direction Gemini might
    # try to reproduce as baked-in shading.
    img[ys, xs] = BASE * (0.42 + 0.58 * np.clip(n[:, 2], 0, 1))[:, None]

    rgb = np.clip(img, 0, 255).astype(np.uint8)
    mask = (cover * 255).astype(np.uint8)
    return rgb, mask, frame


def _shade_raster(m, pts, frame, res):
    from retexture import _raster
    return _raster(pts[:, :2], m['F'], (res, res),
                   attr=dict(n=(m['N'] @ frame['cam'].T).astype(np.float32)),
                   zvals=pts[:, 2])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--mesh', default=None)
    ap.add_argument('--views', default='front,back,left,right')
    ap.add_argument('--res', type=int, default=1024)
    ap.add_argument('--pad', type=float, default=1.15)
    a = ap.parse_args()

    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    _, meshes = load_glb(a.glb)
    name = pick_mesh(meshes, a.mesh)
    if name is None:
        print(json.dumps(dict(ok=False, error='No UV-mapped meshes found in the GLB.')))
        sys.exit(2)
    m = meshes[name]

    wanted = [v.strip() for v in a.views.split(',') if v.strip()]
    unknown = [v for v in wanted if v not in VIEWS]
    if unknown:
        print(json.dumps(dict(ok=False, error=f'unknown view(s) {unknown}, use {list(VIEWS)}')))
        sys.exit(2)

    cams = dict(res=a.res, pad=a.pad, mesh=name, views={})
    for view in wanted:
        rgb, mask, _ = render(m, VIEWS[view], a.res, a.pad)
        if rgb is None:
            # A flat panel seen edge-on rasterizes to nothing. Skip it rather
            # than emit a blank the bake would later treat as a real view.
            continue
        rp = out_dir / f'render.{view}.png'
        mp = out_dir / f'render.{view}.mask.png'
        Image.fromarray(rgb).save(rp, optimize=True)
        Image.fromarray(mask, 'L').save(mp, optimize=True)
        cams['views'][view] = dict(dir=list(VIEWS[view]),
                                   render=rp.name, mask=mp.name,
                                   fill=float((mask > 127).mean()))

    (out_dir / 'cams.json').write_text(json.dumps(cams, indent=2))
    print(json.dumps(dict(ok=True, mesh=name, tris=int(len(m['F'])),
                          res=a.res, views=list(cams['views']),
                          cams='cams.json')))


if __name__ == '__main__':
    main()
