#!/usr/bin/env python3
"""retexture.py - repaint a garment GLB's texture atlas from reference renders.

    pip install trimesh numpy scipy pillow pygltflib scikit-learn

    python retexture.py --glb shirt.glb --view front:design.png --out new.glb
    python retexture.py --glb shirt.glb \
        --view front:front.png --view back:back.png --view left:side.png \
        --out new.glb --preview

No GPU, no Blender, no browser, no API key. The reference must be a render or
photo on a plain background - the background is what the camera fit locks onto.
"""
import argparse, json, pickle, sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import (distance_transform_edt, gaussian_filter,
                           binary_closing, binary_opening)
from scipy.optimize import minimize
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

VIEWS = {'front': (0, 0, -1), 'back': (0, 0, 1),
         'left': (-1, 0, 0), 'right': (1, 0, 0),
         'top': (0, 1, 0)}


# --------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------

def load_glb(path):
    """Return every UV-mapped mesh with node transforms already applied."""
    scene = trimesh.load(path, process=False)
    meshes = {}
    for node in scene.graph.nodes_geometry:
        T, gname = scene.graph[node]
        g = scene.geometry[gname]
        if getattr(g.visual, 'uv', None) is None:
            continue
        R = T[:3, :3]
        meshes[gname] = dict(
            V=(np.asarray(g.vertices) @ R.T) + T[:3, 3],
            N=(np.asarray(g.vertex_normals) @ R.T),
            F=np.asarray(g.faces),
            UV=np.asarray(g.visual.uv),
            geom=g,
            textured=getattr(g.visual.material, 'baseColorTexture', None) is not None,
        )
    return scene, meshes


def islands(V, F):
    """Label connected components. glTF splits vertices at UV seams already."""
    n = len(V)
    r = np.concatenate([F[:, 0], F[:, 1], F[:, 2]])
    c = np.concatenate([F[:, 1], F[:, 2], F[:, 0]])
    A = coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n))
    _, lab = connected_components(A, directed=False)
    return lab


def _cam_basis(view_dir, up=None):
    """Orthographic camera basis for a view direction.

    A view straight down the up axis has no unique roll, and the usual
    up=(0,1,0) degenerates to a zero cross product there. Falling back to +Z
    puts the garment's front at the top of a top-down frame; horizontal views
    keep the old basis exactly.
    """
    d = np.asarray(view_dir, float); d /= np.linalg.norm(d)
    if up is None:
        up = (0, 0, 1) if abs(d[1]) > 0.99 else (0, 1, 0)
    right = np.cross(np.asarray(up, float), -d)
    n = np.linalg.norm(right)
    if n < 1e-9:
        right = np.cross(np.array([0., 0., 1.]), -d)
        n = np.linalg.norm(right)
    right /= n
    return np.stack([right, np.cross(-d, right), -d])


def _raster(pts2, F, shape, attr=None, zvals=None):
    """Shared scanline core. Returns (mask, zbuffer, interpolated attrs)."""
    H, W = shape
    mask = np.zeros((H, W), bool)
    zbuf = np.full((H, W), -np.inf, np.float32)
    out = None if attr is None else {k: np.zeros((H, W, a.shape[1]), np.float32)
                                     for k, a in attr.items()}
    for f in F:
        tri = pts2[f]
        x0 = max(int(tri[:, 0].min()) - 1, 0); x1 = min(int(tri[:, 0].max()) + 2, W)
        y0 = max(int(tri[:, 1].min()) - 1, 0); y1 = min(int(tri[:, 1].max()) + 2, H)
        if x0 >= x1 or y0 >= y1:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1), np.arange(y0, y1))
        qx = xs.ravel() + .5; qy = ys.ravel() + .5
        d = ((tri[1, 0] - tri[0, 0]) * (tri[2, 1] - tri[0, 1]) -
             (tri[2, 0] - tri[0, 0]) * (tri[1, 1] - tri[0, 1]))
        if abs(d) < 1e-12:
            continue
        w1 = ((qx - tri[0, 0]) * (tri[2, 1] - tri[0, 1]) -
              (tri[2, 0] - tri[0, 0]) * (qy - tri[0, 1])) / d
        w2 = ((tri[1, 0] - tri[0, 0]) * (qy - tri[0, 1]) -
              (qx - tri[0, 0]) * (tri[1, 1] - tri[0, 1])) / d
        w0 = 1 - w1 - w2
        eps = -0.003 if attr is not None else 0.0
        ins = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
        if not ins.any():
            continue
        w0 = w0[ins]; w1 = w1[ins]; w2 = w2[ins]
        gx = xs.ravel()[ins]; gy = ys.ravel()[ins]
        if zvals is not None:
            # Screen space: only the nearest fragment may write.
            z = w0 * zvals[f[0]] + w1 * zvals[f[1]] + w2 * zvals[f[2]]
            keep = z > zbuf[gy, gx]
            if not keep.any():
                continue
            gx, gy = gx[keep], gy[keep]
            w0, w1, w2 = w0[keep], w1[keep], w2[keep]
            zbuf[gy, gx] = z[keep]
        if out is not None:
            for k, a in attr.items():
                out[k][gy, gx] = (w0[:, None] * a[f[0]] + w1[:, None] * a[f[1]]
                                  + w2[:, None] * a[f[2]])
        mask[gy, gx] = True
    return mask, zbuf, out


# --------------------------------------------------------------------------
# camera fit
# --------------------------------------------------------------------------

def silhouette(V, F, view_dir, res=700, pad=1.15):
    cam = _cam_basis(view_dir)
    P = (V @ cam.T)[:, :2]
    centre = (P.max(0) + P.min(0)) / 2
    scale = (res / 2) / ((P.max(0) - P.min(0)).max() * pad / 2)
    pts = np.stack([(P[:, 0] - centre[0]) * scale + res / 2,
                    -(P[:, 1] - centre[1]) * scale + res / 2], 1)
    mask, _, _ = _raster(pts, F, (res, res))
    return mask, dict(cam=cam, centre=centre, scale=scale, res=res)


def _iou(sil, ref, s, tx, ty):
    H, W = ref.shape; R = sil.shape[0]
    yy, xx = np.mgrid[0:H, 0:W]
    u = ((xx - tx) / s + R / 2).astype(np.int32)
    v = ((yy - ty) / s + R / 2).astype(np.int32)
    ok = (u >= 0) & (u < R) & (v >= 0) & (v < R)
    w = np.zeros_like(ref); w[ok] = sil[v[ok], u[ok]]
    return (w & ref).sum() / max((w | ref).sum(), 1)


def fit_camera(sil, ref):
    # A degenerate projection (flat panel viewed edge-on) rasterizes to nothing.
    # Score it zero instead of dying, so `auto` can move on to the next axis.
    if not sil.any() or not ref.any():
        return dict(iou=0.0, scale=1.0, tx=ref.shape[1] / 2, ty=ref.shape[0] / 2)
    ry, rx = np.where(ref)
    cx, cy = rx.mean(), ry.mean()
    span = max(rx.max() - rx.min(), ry.max() - ry.min())
    sy, sx = np.where(sil)
    s0 = span / max(sx.max() - sx.min(), sy.max() - sy.min())
    best = max(((_iou(sil, ref, s0 * ds, cx + dx, cy + dy), s0 * ds, cx + dx, cy + dy)
                for ds in np.linspace(.85, 1.2, 15)
                for dx in np.linspace(-24, 24, 9)
                for dy in np.linspace(-24, 24, 9)), key=lambda t: t[0])
    r = minimize(lambda p: -_iou(sil, ref, *p), best[1:], method='Nelder-Mead',
                 options=dict(xatol=.05, fatol=1e-5, maxiter=600))
    return dict(iou=-r.fun, scale=r.x[0], tx=r.x[1], ty=r.x[2])


def project(V, frame, cam):
    P = V @ frame['cam'].T
    k = frame['scale'] * cam['scale']
    return np.stack([(P[:, 0] - frame['centre'][0]) * k + cam['tx'],
                     -(P[:, 1] - frame['centre'][1]) * k + cam['ty'],
                     P[:, 2]], 1)


def identity_cam(res):
    """The camera that maps a frame straight back onto its own silhouette image.

    project(V, frame, identity_cam(frame['res'])) reproduces the pixel
    coordinates silhouette() rasterized. This is the whole basis of the camera
    lock: render the model through a frame, have the render painted without
    reframing, and the fit is known rather than searched for.
    """
    return dict(scale=1.0, tx=res / 2, ty=res / 2)


def pick_mesh(meshes, name=None):
    """Choose the mesh to bake. render_views.py must agree with this exactly,
    or the locked cameras describe a different mesh than the one being baked."""
    if name:
        return name
    textured = next((k for k, v in meshes.items() if v['textured']), None)
    if textured:
        return textured
    if not meshes:
        return None
    return max(meshes.keys(), key=lambda k: len(meshes[k]['F']))


# --------------------------------------------------------------------------
# baking
# --------------------------------------------------------------------------

def atlas_attrs(m, AW, AH):
    pts = np.stack([m['UV'][:, 0] * (AW - 1), m['UV'][:, 1] * (AH - 1)], 1)
    cov, _, out = _raster(pts, m['F'], (AH, AW),
                          attr=dict(pos=m['V'].astype(np.float32),
                                    nrm=m['N'].astype(np.float32)))
    return out['pos'], out['nrm'], cov


def sample(img, x, y):
    H, W = img.shape[:2]
    x = np.clip(x, 0, W - 1.001); y = np.clip(y, 0, H - 1.001)
    x0 = x.astype(int); y0 = y.astype(int)
    fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    a = img[y0, x0].astype(np.float32); b = img[y0, x0 + 1].astype(np.float32)
    c = img[y0 + 1, x0].astype(np.float32); d = img[y0 + 1, x0 + 1].astype(np.float32)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def pick_axis(m, refmask):
    """Try every principal direction and keep whichever silhouette fits best."""
    scores = {}
    for k, vd in VIEWS.items():
        sil, frame = silhouette(m['V'], m['F'], vd)
        scores[k] = (fit_camera(sil, refmask)['iou'], vd)
    order = sorted(scores.items(), key=lambda kv: -kv[1][0])
    print("    axis search: " + ", ".join(f"{k} {v[0]:.3f}" for k, v in order))
    return order[0][0], order[0][1][1]


def bake_view(m, pos, nrm, cov, ref, refmask, view_dir, verbose=True,
              cam=None, res=700, pad=1.15, depth_tol=0.03):
    """Sample one reference into the atlas.

    `cam` is the mapping from the model's silhouette frame into the reference
    image. Pass it when the reference was painted over a render made through
    that same frame -- then the fit is known and there is nothing to search
    for. Leave it None to recover it from the silhouette, which is the only
    option for a reference that came from a camera rather than from us.
    """
    sil, frame = silhouette(m['V'], m['F'], view_dir, res=res, pad=pad)
    if cam is None:
        cam = fit_camera(sil, refmask)
        note = ""
    else:
        note = "  (camera locked to the render)"
    if verbose:
        flag = "" if cam['iou'] > .75 else "   <-- LOW: wrong axis, wrong garment, or perspective reference"
        print(f"    silhouette IoU {cam['iou']:.3f}{note}{flag}")

    AH, AW = cov.shape
    P = project(pos.reshape(-1, 3), frame, cam).reshape(AH, AW, 3)
    px, py, pz = P[..., 0], P[..., 1], P[..., 2]

    pts = project(m['V'], frame, cam)
    _, zbuf, _ = _raster(pts[:, :2], m['F'], ref.shape[:2], zvals=pts[:, 2])

    H, W = ref.shape[:2]
    inframe = (px >= 0) & (px < W - 1) & (py >= 0) & (py < H - 1)
    zi = np.zeros_like(pz)
    zi[inframe] = zbuf[np.clip(py[inframe].astype(int), 0, H - 1),
                       np.clip(px[inframe].astype(int), 0, W - 1)]
    nl = nrm / np.maximum(np.linalg.norm(nrm, axis=2, keepdims=True), 1e-9)
    facing = (nl * frame['cam'][2]).sum(2)
    span = float(np.ptp((m['V'] @ frame['cam'].T)[:, 2]))

    # The depth slop has to cover camera-fit error, but a garment is a thin
    # shell: at the default 3% of depth span this tolerance is ~48x the fabric's
    # own thickness, so the collar's inner face passes the test alongside its
    # outer face and gets painted with whatever the 2D view had at the neck
    # opening -- which is the dark hole. A locked camera has no fit error, so it
    # can afford a far tighter tolerance.
    seen = cov & inframe & (facing > .06) & (pz > zi - span * depth_tol)
    rgb = np.zeros((AH, AW, 3), np.float32)
    ys, xs = np.where(seen)
    rgb[ys, xs] = sample(ref, px[ys, xs], py[ys, xs])
    return rgb, seen, facing, cam['iou']


def _letterbox(im, res):
    """Fit an image onto a res x res canvas without changing its aspect.

    The render was square; a painted version of it should come back square. If
    the generator reframed to some other aspect, scaling to fit is the only
    reading that keeps the garment's proportions, and the overlap test below
    will catch it if the reframing moved anything that matters.
    """
    im = im.convert('RGBA')
    s = res / max(im.size)
    w, h = max(1, round(im.width * s)), max(1, round(im.height * s))
    im = im.resize((w, h), Image.LANCZOS)
    canvas = Image.new('RGBA', (res, res), (255, 255, 255, 0))
    canvas.paste(im, ((res - w) // 2, (res - h) // 2))
    return canvas


def locked_reference(lock, base, res, thresh):
    """Resolve a painted view against the render it was painted over.

    Returns (rgb, mask, cam, overlap). A non-None cam means the painted view
    still sits where the render did, so the model's own silhouette is used as
    the mask and the camera is exact. A None cam means it drifted and the
    caller should fall back to fitting -- still on the right axis, which is
    most of what the axis search used to get wrong.
    """
    rmask = np.array(Image.open(base / lock['mask']).convert('L')) > 127
    painted = Image.open(base / lock['painted'])

    sq = np.array(_letterbox(painted, res))
    gmask = sq[..., 3] > 10
    if not gmask.any():                      # no alpha survived; read the white out
        gmask = sq[..., :3].mean(2) < 244
    overlap = float((gmask & rmask).sum() / max((gmask | rmask).sum(), 1))

    if overlap >= thresh:
        # The model's silhouette wins over whatever the generator drew. Texels
        # the paint did not reach sample the white underneath, which palette
        # snapping and edge dilation absorb.
        return sq[..., :3].copy(), rmask, dict(identity_cam(res), iou=overlap), overlap

    arr = np.array(painted.convert('RGBA'))
    fallback = arr[..., 3] > 10
    if not fallback.any():
        fallback = arr[..., :3].mean(2) < 244
    return arr[..., :3].copy(), fallback, None, overlap


def extract_palette(refs, k=8, merge=48):
    """Cluster the references, then merge shading variants of one flat colour."""
    from sklearn.cluster import KMeans
    px = np.concatenate([r[m] for r, m in refs]).astype(float)
    if len(px) > 200000:
        px = px[np.random.default_rng(0).choice(len(px), 200000, replace=False)]
    km = KMeans(k, n_init=10, random_state=0).fit(px)
    cen = km.cluster_centers_
    share = np.bincount(km.labels_, minlength=k) / len(km.labels_)
    order = np.argsort(-share)
    keep = []
    for i in order:
        if all(np.linalg.norm(cen[i] - cen[j]) > merge for j in keep):
            keep.append(i)
    return cen[keep], share[keep]


def edge_dilate(rgb, mask, iters):
    rgb = rgb.astype(np.float32).copy(); mask = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(rgb); cnt = np.zeros(mask.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == dy == 0:
                    continue
                mm = np.roll(np.roll(mask, dy, 0), dx, 1)
                acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * mm[..., None]
                cnt += mm
        grow = (~mask) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow, None]
        mask |= grow
    return rgb


def build_atlas(rgb, seen, cov, isl, palette, keep_pixels, min_share=.07):
    """Panels with artwork keep their pixels; the rest snap to flat colour.

    Each panel is restricted to the palette entries it actually contains, which
    is what stops antialiased edge pixels being read as a neighbour's colour.
    """
    AH, AW, _ = rgb.shape
    out = np.zeros_like(rgb)
    white = palette[np.argmax(palette.sum(1))]

    for i in np.unique(isl[cov]):
        i = int(i)
        region = cov & (isl == i)
        src = region & seen
        if not region.any():
            continue

        if i in keep_pixels:
            sub = rgb.copy()
            L = np.where(region, sub.mean(2), 0).astype(np.float32)
            Wt = region.astype(np.float32)
            base = gaussian_filter(L, 45) / np.maximum(gaussian_filter(Wt, 45), 1e-6)
            if src.any():
                gain = np.clip(np.percentile(base[src], 90) / np.maximum(base, 1e-6), .8, 1.4)
                sub[region] = sub[region] * gain[region][:, None]
            sub[region & (sub.min(2) > 188) & (sub.max(2) - sub.min(2) < 14)] = white
            hole = region & ~seen
            if hole.any() and src.any():
                _, idx = distance_transform_edt(~src, return_indices=True)
                sub[hole] = sub[idx[0][hole], idx[1][hole]]
            out[region] = sub[region]
            continue

        if src.sum() < 40:
            out[region] = white
            continue

        d = np.linalg.norm(rgb[src][:, None, :] - palette[None, :, :], axis=2)
        lab = np.argmin(d, 1)
        share = np.bincount(lab, minlength=len(palette)) / len(lab)
        allowed = np.where(share >= min_share)[0]
        if len(allowed) == 0:
            allowed = np.array([lab[0]])
        if len(allowed) == 1:
            out[region] = palette[allowed[0]]
            continue

        keepmask = np.isin(lab, allowed)
        sy, sx = np.where(src)
        sy, sx, lab = sy[keepmask], sx[keepmask], lab[keepmask]
        votes = np.zeros((AH, AW, len(allowed)), np.float32)
        for n, c in enumerate(allowed):
            v = np.zeros((AH, AW), np.float32)
            v[sy[lab == c], sx[lab == c]] = 1
            votes[..., n] = gaussian_filter(v, 12)
        choice = np.argmax(votes, 2)
        weak = votes.sum(2) < 1e-5

        # Unseen texels take the label of the nearest seen texel in 3D, so a
        # side band continues along the seam instead of being guessed in UV.
        hy, hx = np.where(region & weak)
        if len(hy):
            tree = cKDTree(POS[sy, sx])
            dist, j = tree.query(POS[hy, hx])
            near = dist < SPAN * .06
            choice[hy[near], hx[near]] = lab[j[near]]
            choice[hy[~near], hx[~near]] = int(np.argmax(
                [palette[c].sum() for c in allowed]))

        for n in range(len(allowed)):
            m2 = region & (choice == n)
            m2 = binary_opening(binary_closing(m2, np.ones((11, 11))), np.ones((7, 7)))
            choice[region & m2] = n
        out[region] = palette[allowed[np.clip(choice, 0, len(allowed) - 1)[region]]]

    return np.clip(edge_dilate(out, cov, 14), 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------
# glb writing
# --------------------------------------------------------------------------

def write_glb(src, dst, png_bytes, mat_name=None):
    """Swap the texture bytes in place, or add a texture if missing, and repack.

    `mat_name` scopes the change to the baked mesh's material. Without it a GLB
    that ships no texture at all gets the new atlas stapled onto every material
    it has -- including trims like laces that were never baked and whose UVs
    point at unrelated corners of the atlas.
    """
    from pygltflib import GLTF2, Image as gltfImage, Texture, TextureInfo, BufferView, Buffer
    g = GLTF2().load(str(src))

    mats = [mt for mt in g.materials if mt.name == mat_name] if mat_name else []
    if not mats:
        mats = list(g.materials)

    idx = None
    for mat in mats:
        if mat.pbrMetallicRoughness is None: continue
        bct = getattr(mat.pbrMetallicRoughness, 'baseColorTexture', None)
        if bct is not None:
            idx = g.textures[bct.index].source
            break

    if idx is None:
        g.images.append(gltfImage(mimeType="image/png"))
        idx = len(g.images) - 1
        g.textures.append(Texture(source=idx))
        tex_idx = len(g.textures) - 1
        for mat in mats:
            if mat.pbrMetallicRoughness is None: continue
            mat.pbrMetallicRoughness.baseColorTexture = TextureInfo(index=tex_idx)
            mat.pbrMetallicRoughness.baseColorFactor = [1.0, 1.0, 1.0, 1.0]

    if g.images[idx].bufferView is None:
        g.bufferViews.append(BufferView(buffer=0, byteOffset=0, byteLength=0))
        g.images[idx].bufferView = len(g.bufferViews) - 1

    blob = g.binary_blob()
    if blob is None: blob = b""
    datas = []
    for bv in g.bufferViews:
        start = bv.byteOffset or 0
        length = bv.byteLength or 0
        datas.append(bytearray(blob[start:start+length]))

    datas[g.images[idx].bufferView] = bytearray(png_bytes)
    
    packed = bytearray()
    for bv, d in zip(g.bufferViews, datas):
        while len(packed) % 4:
            packed.append(0)
        bv.byteOffset = len(packed); bv.byteLength = len(d)
        packed += d
    while len(packed) % 4:
        packed.append(0)
        
    if not g.buffers:
        g.buffers.append(Buffer(byteLength=0))
    g.buffers[0].byteLength = len(packed)
    g.set_binary_blob(bytes(packed))
    g.save(str(dst))


def flat_colour(geom):
    """A material's baseColorFactor as 0-255 RGB. trimesh hands these back as
    floats or bytes depending on the file, so normalise rather than assume."""
    f = getattr(getattr(geom, 'visual', None) and geom.visual.material,
                'baseColorFactor', None)
    if f is None:
        return np.array([180., 180., 180.])
    f = np.asarray(f, float)[:3]
    return f * 255 if f.max() <= 1.0 else f


def preview(draws, path, size=(300, 375)):
    """Render the mesh set a glTF viewer would show, not just the baked one.

    `draws` is a list of (mesh, tex, colour); tex is the new atlas for the mesh
    that was baked and None for trims that kept their flat material. A depth
    test shared across meshes is what keeps the laces in front of the body --
    rendering each mesh into its own buffer would let the last one drawn win.
    """
    dirs = [(0, 0, -1), (-.7, .1, -.7), (-1, 0, 0), (.85, 0, .5), (0, 0, 1)]
    W, H = size
    allV = np.concatenate([d[0]['V'] for d in draws])
    tiles = []
    for vd in dirs:
        cam = _cam_basis(vd)
        Pa = allV @ cam.T
        c = (Pa.max(0) + Pa.min(0)) / 2
        s = (min(size) / 2) / ((Pa.max(0) - Pa.min(0))[:2].max() * 1.08 / 2)

        img = np.full((H, W, 3), 255, np.float32)
        best = np.full((H, W), -np.inf, np.float32)
        for mm, tex, colour in draws:
            P = mm['V'] @ cam.T
            pts = np.stack([(P[:, 0] - c[0]) * s + W / 2,
                            -(P[:, 1] - c[1]) * s + H / 2], 1)
            mask, zbuf, out = _raster(pts, mm['F'], (H, W),
                                      attr=dict(uv=mm['UV'].astype(np.float32),
                                                n=(mm['N'] @ cam.T).astype(np.float32)),
                                      zvals=P[:, 2])
            ys, xs = np.where(mask & (zbuf > best))
            if not len(ys):
                continue
            best[ys, xs] = zbuf[ys, xs]
            nn = out['n'][ys, xs]
            nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
            if tex is not None:
                uv = out['uv'][ys, xs]
                th, tw = tex.shape[:2]
                tx = (np.clip(uv[:, 0], 0, 1) * (tw - 1)).astype(int)
                ty = ((1 - np.clip(uv[:, 1], 0, 1)) * (th - 1)).astype(int)
                base = tex[ty, tx].astype(np.float32)
            else:
                base = np.broadcast_to(colour, (len(ys), 3)).astype(np.float32)
            img[ys, xs] = base * (.55 + .45 * np.clip(nn[:, 2], 0, 1))[:, None]
        tiles.append(np.clip(img, 0, 255).astype(np.uint8))
    Image.fromarray(np.concatenate(tiles, 1)).save(path)


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--glb', required=True)
    ap.add_argument('--view', action='append', required=True,
                    help='front:img.png | back:img.png | left:img.png | right:img.png')
    ap.add_argument('--out', required=True)
    ap.add_argument('--mesh', default=None, help='mesh name (default: the textured one)')
    ap.add_argument('--size', type=int, default=2048)
    ap.add_argument('--keep', default='auto',
                    help='comma-separated island ids that keep pixel detail, or auto')
    ap.add_argument('--colors', type=int, default=6)
    ap.add_argument('--bg', type=int, default=252, help='background brightness cutoff')
    ap.add_argument('--cams', default=None,
                    help='cams.json from render_views.py; locks views to the render camera')
    ap.add_argument('--lock-iou', type=float, default=0.90,
                    help='overlap a painted view must keep with its render to stay locked')
    ap.add_argument('--min-facing', type=float, default=0.0,
                    help='drop texels no view ever caught this square-on; 0 keeps all')
    ap.add_argument('--depth-tol', type=float, default=None,
                    help='depth slop as a fraction of view depth span (default 0.03). '
                         'Tightening it does NOT fix the collar-interior artifact; '
                         'measured, no visible change from 0.03 down to 0.002.')
    ap.add_argument('--preview', action='store_true')
    a = ap.parse_args()

    cams = cbase = None
    if a.cams:
        cbase = Path(a.cams).parent
        cams = json.loads(Path(a.cams).read_text())

    scene, meshes = load_glb(a.glb)
    if not meshes:
        sys.exit("No UV-mapped meshes found in the GLB.")
    name = pick_mesh(meshes, a.mesh or (cams or {}).get('mesh'))
    if name not in meshes:
        sys.exit(f"mesh '{name}' is not in this GLB - {list(meshes)}")
    if not meshes[name]['textured']:
        print(f"No textured mesh found, defaulting to largest mesh '{name}'")
    m = meshes[name]
    print(f"mesh {name}: {len(m['F'])} tris, {len(m['V'])} verts")

    tex0 = m['geom'].visual.material.baseColorTexture
    AW = a.size
    AH = int(round(AW * tex0.size[1] / tex0.size[0])) if tex0 else AW
    print(f"atlas {AW}x{AH} (matching the original's aspect)")

    isl = islands(m['V'], m['F'])
    print(f"UV islands: {isl.max() + 1}")

    uv_area = 0.0
    for i in range(isl.max() + 1):
        sel = isl[m['F'][:, 0]] == i
        if not sel.any():
            continue
        t = m['UV'][m['F'][sel]]
        e1 = t[:, 1] - t[:, 0]; e2 = t[:, 2] - t[:, 0]
        uv_area += float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum()) / 2
    if uv_area > 1.35:
        print(f"  WARNING: island areas sum to {uv_area:.2f} of UV space - panels "
              f"overlap in the atlas. Anything painted on one lands on the other.")

    pos, nrm, cov = atlas_attrs(m, AW, AH)
    global POS, SPAN
    POS = pos
    SPAN = float(np.linalg.norm(m['V'].max(0) - m['V'].min(0)))

    islmap = np.zeros(cov.shape, int)
    pts = np.stack([m['UV'][:, 0] * (AW - 1), m['UV'][:, 1] * (AH - 1)], 1)
    _, _, o = _raster(pts, m['F'], (AH, AW),
                      attr=dict(i=isl.reshape(-1, 1).astype(np.float32)))
    islmap = np.round(o['i'][..., 0]).astype(int)

    acc_rgb = np.zeros((AH, AW, 3), np.float32)
    acc_w = np.zeros((AH, AW), np.float32)
    best_face = np.full((AH, AW), -1.0, np.float32)
    refs = []
    for spec in a.view:
        key, _, path = spec.partition(':')
        if key not in VIEWS and key != 'auto':
            sys.exit(f"unknown view '{key}' - use auto or one of {list(VIEWS)}")

        lock = cams['views'].get(key) if cams else None
        if lock and lock.get('painted'):
            img, rm, cam, overlap = locked_reference(lock, cbase, cams['res'], a.lock_iou)
            name_shown = Path(lock['painted']).name
            print(f"  {key}: {name_shown} {img.shape[1]}x{img.shape[0]}")
            if cam is None:
                print(f"    WARNING: the painted view drifted from the render "
                      f"(overlap {overlap:.3f} < {a.lock_iou:.2f}); fitting the "
                      f"camera on the known axis instead")
            vd = tuple(lock['dir'])
            res, pad = (cams['res'], cams['pad']) if cam else (700, 1.15)
        else:
            img_pil = Image.open(path)
            img = np.array(img_pil.convert('RGB'))
            if img_pil.mode in ('RGBA', 'LA', 'P') and img_pil.convert('RGBA').getextrema()[3][0] < 255:
                rm = np.array(img_pil.convert('RGBA'))[:, :, 3] > 10
            else:
                rm = img.mean(2) < a.bg

            if rm.mean() > .99:
                sys.exit(f"{path}: almost everything reads as foreground. The "
                         f"background must be plain and light - tune --bg.")
            print(f"  {key}: {Path(path).name} {img.shape[1]}x{img.shape[0]}")
            cam = None
            vd = VIEWS[key] if key in VIEWS else pick_axis(m, rm)[1]
            res, pad = 700, 1.15

        refs.append((img, rm))
        dtol = a.depth_tol if a.depth_tol is not None else 0.03
        rgb, seen, facing, iou = bake_view(m, pos, nrm, cov, img, rm, vd,
                                           cam=cam, res=res, pad=pad, depth_tol=dtol)
        w = np.where(seen, np.clip(facing, 0, 1) ** 3, 0)
        acc_rgb += rgb * w[..., None]
        acc_w += w
        best_face = np.maximum(best_face, np.where(seen, facing, -1.0))

    seen = acc_w > 0

    # A surface nearly edge-on to every view samples a sliver of the reference
    # and stretches it across the whole panel. That is where the smeared streaks
    # on shoulder tops and collar rims come from: the texels are "seen", just
    # never squarely. Drop them and let the hole fill continue a neighbouring
    # panel instead, which is wrong in a way that reads as fabric.
    grazing = seen & (best_face < a.min_facing)
    if grazing.any():
        print(f"grazing texels dropped: {100 * grazing.sum() / cov.sum():.1f}% of "
              f"the atlas was only ever caught below {a.min_facing:.2f} facing")
        seen = seen & ~grazing

    rgb = np.zeros_like(acc_rgb)
    rgb[seen] = acc_rgb[seen] / acc_w[seen, None]
    print(f"coverage: {100 * seen.sum() / cov.sum():.1f}% of the atlas was seen")

    palette, share = extract_palette(refs, a.colors)
    print("palette:")
    for c, s in zip(palette, share):
        print(f"  rgb({c[0]:3.0f},{c[1]:3.0f},{c[2]:3.0f})  {100 * s:4.1f}%")

    if a.keep == 'auto':
        keep = set()
        for i in np.unique(islmap[cov]):
            i = int(i); r = cov & (islmap == i); sr = r & seen
            if not r.sum() or sr.sum() < 200:
                continue
            vis = sr.sum() / r.sum()
            # Artwork shows up as colour the flat palette cannot explain.
            resid = np.linalg.norm(rgb[sr][:, None, :] - palette[None, :, :],
                                   axis=2).min(1).mean()
            if vis > .8 and resid > 16:
                keep.add(i)
            print(f"  island {i:2d}: {100*vis:5.1f}% seen, palette residual {resid:5.1f}"
                  f"{'  -> keeps pixels' if i in keep else ''}")
    else:
        keep = {int(x) for x in a.keep.split(',') if x.strip()}

    atlas = build_atlas(rgb, seen, cov, islmap, palette, keep)
    out_png = Path(a.out).with_suffix('.png')
    Image.fromarray(atlas[::-1]).save(out_png, optimize=True)

    mat_name = getattr(m['geom'].visual.material, 'name', None)
    write_glb(a.glb, a.out, out_png.read_bytes(), mat_name=mat_name)
    others = [k for k in meshes if k != name]
    if others and mat_name:
        print(f"textured material '{mat_name}'; left {len(others)} other mesh(es) "
              f"on their original materials: {', '.join(others)}")
    print(f"wrote {a.out} and {out_png}")

    if a.preview:
        tex_img = atlas[::-1]
        draws = [(m, tex_img, None)] + [
            (meshes[k], None, flat_colour(meshes[k]['geom'])) for k in others]
        preview(draws, Path(a.out).with_suffix('.preview.png'))
        print(f"wrote {Path(a.out).with_suffix('.preview.png')}")


if __name__ == '__main__':
    main()
