"""Paint a design reference onto renders of the actual mesh — Python port of the
teammate's gemini.js. The render is the SHAPE authority; the reference is the
DESIGN source. Every prompt rule exists to keep those roles from swapping.
"""
from __future__ import annotations

import base64
import concurrent.futures as cf
from pathlib import Path

import requests

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"

MODELS = {
    "quality": "gemini-3-pro-image-preview",
    "fast": "gemini-3.1-flash-image",
}

VIEW_BRIEF = {
    "front": "the front of the garment",
    "back": "the back of the garment",
    "left": "the left side of the garment, in pure profile",
    "right": "the right side of the garment, in pure profile",
}

PANEL_RULE = {
    "back": [
        "This is the BACK of the garment.",
        "Do not repeat the front's logo, crest or chest graphic here. A garment's",
        "back does not carry its front artwork.",
        "Continue the colour blocking, stripes and pattern flow around from the",
        "reference so the seams line up, and leave the panel plain otherwise.",
    ],
    "left": [
        "This is the LEFT FLANK and sleeve, seen edge-on.",
        "Continue only the colour blocking, stripes and pattern flow.",
        "Logos, crests, names and numbers live on the front and back panels. Do not",
        "place any of them here, and do not repeat a number onto the sleeve.",
    ],
    "right": [
        "This is the RIGHT FLANK and sleeve, seen edge-on.",
        "Continue only the colour blocking, stripes and pattern flow.",
        "Logos, crests, names and numbers live on the front and back panels. Do not",
        "place any of them here, and do not repeat a number onto the sleeve.",
    ],
}

INVENT_RULE = (
    "Do not invent text, numbers or marks that are not in the reference. An empty "
    "panel is correct; an invented one is not."
)


def build_prompt(view: str, back_text: str | None = None) -> str:
    lines = [
        f"IMAGE 1 is an untextured render of a 3D garment, showing {VIEW_BRIEF[view]}.",
        "IMAGE 2 is a design reference: a different garment carrying the artwork we want.",
        "",
        "Apply the design from IMAGE 2 onto the garment in IMAGE 1.",
        "",
        "Shape rules, all mandatory:",
        "- Reproduce IMAGE 1 exactly in outline, proportion, framing, position and scale.",
        "- The result must overlay IMAGE 1 pixel for pixel. Do not move, rotate, crop,",
        "  zoom, or re-centre the garment. Do not extend or shorten the sleeves, the",
        "  body or the hem. Do not change the collar.",
        "- IMAGE 2 may be a different cut, length or fit. Ignore its shape entirely.",
        "  Take only colour, pattern, artwork and placement from it.",
        "",
        "Design rules:",
        "- Match IMAGE 2's colours exactly. Do not restyle or recolour.",
        "- Scale the artwork to sit naturally on this garment's panels.",
        "- Keep every graphic fully inside the garment's outline. Nothing may run off",
        "  the edge of a panel or be clipped by the silhouette.",
        "- Keep the shading of IMAGE 1 only where it reads as fabric fold. Do not bake",
        "  in a hard light source or a cast shadow.",
        "",
        "Output rules:",
        "- Pure white background, nothing else in frame. No person, mannequin, hanger.",
        "- Flat orthographic product view, no perspective, no tilt.",
    ]
    if view in PANEL_RULE:
        lines += ["", *PANEL_RULE[view], INVENT_RULE]
        if view == "back" and back_text:
            lines += [
                "",
                f'The one exception: place "{back_text}" on the upper back, in the',
                "reference's own lettering style and colours. Nothing else.",
            ]
    return "\n".join(lines)


def _as_part(path: str) -> dict:
    b64 = base64.b64encode(Path(path).read_bytes()).decode()
    return {"inlineData": {"mimeType": "image/png", "data": b64}}


def _call_gemini(api_key: str, model: str, image_paths: list[str], prompt: str,
                 timeout: int = 180) -> bytes:
    parts = [_as_part(p) for p in image_paths] + [{"text": prompt}]
    res = requests.post(
        f"{ENDPOINT}/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {"imageSize": "2K"},
            },
        },
        timeout=timeout,
    )
    if not res.ok:
        raise RuntimeError(f"Gemini {res.status_code}: {res.text[:300]}")
    data = res.json()
    cand = (data.get("candidates") or [{}])[0]
    for p in cand.get("content", {}).get("parts", []):
        inline = p.get("inlineData")
        if inline and inline.get("data"):
            return base64.b64decode(inline["data"])
    raise RuntimeError(f"Gemini returned no image ({cand.get('finishReason', 'no image')})")


def paint_views(api_key: str, reference_path: str, renders: dict[str, str],
                tier: str = "fast", back_text: str | None = None, log=None) -> dict[str, bytes]:
    """renders: {view -> render png path}. Returns {view -> painted png bytes},
    a view missing on failure (a failed view degrades coverage, never fails the bake)."""
    model = MODELS.get(tier, MODELS["fast"])
    out: dict[str, bytes] = {}

    def one(view: str) -> tuple[str, bytes]:
        if log:
            log(f"  painting {view} over the model's own render ({model})")
        # order matters: IMAGE 1 = render (shape), IMAGE 2 = reference (design)
        png = _call_gemini(api_key, model, [renders[view], reference_path],
                           build_prompt(view, back_text))
        return view, png

    with cf.ThreadPoolExecutor(max_workers=len(renders) or 1) as ex:
        futures = {ex.submit(one, v): v for v in renders}
        for fut in cf.as_completed(futures):
            v = futures[fut]
            try:
                view, png = fut.result()
                out[view] = png
                if log:
                    log(f"  {view} painted ({len(png) // 1024} KB)")
            except Exception as e:  # noqa: BLE001
                if log:
                    log(f"  {v} failed: {e}")
    return out
