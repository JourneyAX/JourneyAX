#!/usr/bin/env python3
"""prep.py - turn an arbitrary reference photo into something retexture.py can fit.

    python prep.py --in raw.jpg --out cut.png

Emits one line of JSON on stdout describing the result.

The camera fit in retexture.py locks onto the silhouette, so the single most
damaging thing in a reference is anything inside the outline that is not the
garment: a person, a hanger, a mannequin, a shadow. This strips that out.

Output is RGBA. The alpha channel is the mask retexture.py reads directly. The
RGB under transparent pixels is set to white rather than left black, so that a
silhouette that overshoots by a few pixels samples white instead of black --
white gets absorbed by palette snapping and edge dilation, black does not.
"""
import argparse, json, sys
import numpy as np
from PIL import Image


def cut_with_rembg(img):
    """Preferred path. Returns an alpha mask or None if rembg is unavailable."""
    try:
        from rembg import remove
    except ImportError:
        return None
    out = remove(img.convert('RGBA'))
    return np.array(out)[:, :, 3]


def cut_with_corners(img, tol=38):
    """Fallback: flood the background in from the border by colour distance.

    Only works when the background is already plain. It is a safety net for
    environments without rembg, not a substitute for it.
    """
    from scipy.ndimage import binary_fill_holes, label
    a = np.array(img.convert('RGB')).astype(np.int16)
    H, W = a.shape[:2]
    corners = np.concatenate([a[:6, :6].reshape(-1, 3), a[:6, -6:].reshape(-1, 3),
                              a[-6:, :6].reshape(-1, 3), a[-6:, -6:].reshape(-1, 3)])
    bg = np.median(corners, 0)
    near_bg = np.linalg.norm(a - bg, axis=2) < tol

    # Keep only background regions that touch the border; a white shirt panel
    # in the middle of a white background must not be flooded away.
    lab, n = label(near_bg)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    border.discard(0)
    outside = np.isin(lab, list(border)) if border else np.zeros_like(near_bg)
    return (binary_fill_holes(~outside) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst', required=True)
    ap.add_argument('--pad', type=float, default=0.06, help='margin as a fraction of the long edge')
    ap.add_argument('--max', type=int, default=1600, help='longest output edge')
    ap.add_argument('--no-rembg', action='store_true')
    ap.add_argument('--full', default=None,
                    help='also write the cut-out at its original framing (no crop, '
                         'no pad) for callers that need it to stay aligned with a render')
    a = ap.parse_args()

    img = Image.open(a.src)
    if img.mode == 'P':
        img = img.convert('RGBA')

    method = 'alpha'
    if img.mode in ('RGBA', 'LA') and np.array(img.convert('RGBA'))[:, :, 3].min() < 255:
        alpha = np.array(img.convert('RGBA'))[:, :, 3]
    else:
        alpha = None if a.no_rembg else cut_with_rembg(img)
        method = 'rembg'
        if alpha is None:
            alpha = cut_with_corners(img)
            method = 'corner-flood'

    rgb = np.array(img.convert('RGB'))
    mask = alpha > 10
    frac = float(mask.mean())
    if frac < 0.01:
        print(json.dumps(dict(ok=False, method=method, foreground=frac,
                              error='Cut-out found almost no garment. Try a clearer '
                                    'photo, or upload a PNG that already has a '
                                    'transparent background.')))
        sys.exit(2)
    if frac > 0.985:
        print(json.dumps(dict(ok=False, method=method, foreground=frac,
                              error='Cut-out found almost no background. The garment '
                                    'must not fill the entire frame.')))
        sys.exit(2)

    # A painted view has to stay registered against the render it was painted
    # over, and cropping to the garment throws that registration away. Write
    # the uncropped cut-out first, off the same single rembg pass. Uniform
    # downscaling is fine -- it is a scale factor, and both consumers of this
    # file either rescale to a known size or solve for scale.
    if a.full:
        full = Image.fromarray(np.dstack([np.where(mask[..., None], rgb, 255)
                                          .astype(np.uint8), alpha]))
        if max(full.size) > a.max:
            s = a.max / max(full.size)
            full = full.resize((int(full.width * s), int(full.height * s)), Image.LANCZOS)
        full.save(a.full, optimize=True)

    # Tight crop around the garment, then a uniform margin. The camera fit
    # searches a limited scale range, so a consistent framing helps it converge.
    ys, xs = np.where(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgb = rgb[y0:y1, x0:x1]
    alpha = alpha[y0:y1, x0:x1]
    mask = mask[y0:y1, x0:x1]

    rgb = np.where(mask[..., None], rgb, 255).astype(np.uint8)

    pad = int(round(max(rgb.shape[:2]) * a.pad))
    rgb = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), constant_values=255)
    alpha = np.pad(alpha, ((pad, pad), (pad, pad)), constant_values=0)

    out = Image.fromarray(np.dstack([rgb, alpha]))
    if max(out.size) > a.max:
        s = a.max / max(out.size)
        out = out.resize((int(out.width * s), int(out.height * s)), Image.LANCZOS)
    out.save(a.dst, optimize=True)

    print(json.dumps(dict(ok=True, method=method, foreground=frac,
                          width=out.width, height=out.height, out=a.dst,
                          full=a.full)))


if __name__ == '__main__':
    main()
