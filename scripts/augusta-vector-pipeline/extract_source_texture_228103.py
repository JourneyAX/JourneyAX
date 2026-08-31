#!/usr/bin/env python3
"""Extract source-faithful artwork from a front mockup into the 228103 UV atlas.

This is the fidelity pass that complements the semantic vector master. It preserves
the uploaded image's actual crest pixels, color relationships, fabric grain, distress,
and shading on the visible front and sleeves. Unseen surfaces remain clearly inferred.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from skimage.color import rgb2hsv
from skimage.transform import ProjectiveTransform, warp


VIEW_W = 1132.2
VIEW_H = 1460.56


def _scale_points(points: list[tuple[float, float]], width: int, height: int) -> np.ndarray:
    return np.asarray(
        [(x * width / VIEW_W, y * height / VIEW_H) for x, y in points],
        dtype=np.float64,
    )


def _warp_quad(
    source: Image.Image,
    source_quad: list[tuple[float, float]],
    target_quad: np.ndarray,
    output_size: tuple[int, int],
) -> Image.Image:
    width, height = output_size
    source_rgb = np.asarray(source.convert('RGB'), dtype=np.float32) / 255.0

    # skimage.warp requires output-to-input coordinates.
    output_to_input = ProjectiveTransform.from_estimate(
        target_quad,
        np.asarray(source_quad, dtype=np.float64),
    )
    warped = warp(
        source_rgb,
        inverse_map=output_to_input,
        output_shape=(height, width),
        preserve_range=True,
        mode='edge',
    )
    warped_rgb = Image.fromarray(np.clip(warped * 255.0, 0, 255).astype(np.uint8), 'RGB')

    mask = Image.new('L', (width, height), 0)
    ImageDraw.Draw(mask).polygon([tuple(point) for point in target_quad], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(width / 1800, 1.0)))
    warped_rgb.putalpha(mask)
    return warped_rgb


def _erase_polygon(
    image: Image.Image,
    points: np.ndarray,
    feather: float = 5.0,
) -> None:
    """Remove a mapped photographic feature supplied by separate 3D geometry."""
    alpha = image.getchannel('A')
    erase = Image.new('L', image.size, 0)
    ImageDraw.Draw(erase).polygon([tuple(point) for point in points], fill=255)
    erase = erase.filter(ImageFilter.GaussianBlur(feather))
    alpha_array = np.asarray(alpha, dtype=np.float32)
    erase_array = np.asarray(erase, dtype=np.float32) / 255.0
    alpha = Image.fromarray(
        np.clip(alpha_array * (1.0 - erase_array), 0, 255).astype(np.uint8),
        'L',
    )
    image.putalpha(alpha)


def _garment_palette(source: Image.Image, count: int = 10) -> list[dict[str, object]]:
    rgb = source.convert('RGB')
    mask = Image.new('L', rgb.size, 0)
    garment = [
        (453, 86), (748, 88), (1006, 186), (1138, 1005),
        (918, 1087), (282, 1088), (68, 1020), (168, 194),
    ]
    ImageDraw.Draw(mask).polygon(garment, fill=255)
    masked = Image.new('RGB', rgb.size, '#000000')
    masked.paste(rgb, mask=mask)
    sample = masked.resize((300, 300), Image.Resampling.LANCZOS)
    pixels = np.asarray(sample)
    valid = pixels[np.max(pixels, axis=2) > 22]
    strip = Image.fromarray(valid.reshape((-1, 1, 3)), 'RGB')
    quantized = strip.quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    colors = quantized.getcolors(maxcolors=256) or []
    palette = quantized.getpalette() or []
    result = []
    for population, index in sorted(colors, reverse=True):
        r, g, b = palette[index * 3:index * 3 + 3]
        result.append(
            {
                'hex': f'#{r:02X}{g:02X}{b:02X}',
                'rgb': [r, g, b],
                'samplePixels': int(population),
            }
        )
    return result


def _semantic_palette(source: Image.Image) -> dict[str, dict[str, object]]:
    rgb_image = source.convert('RGB')
    mask = Image.new('L', rgb_image.size, 0)
    ImageDraw.Draw(mask).polygon(
        [
            (453, 86), (748, 88), (1006, 186), (1138, 1005),
            (918, 1087), (282, 1088), (68, 1020), (168, 194),
        ],
        fill=255,
    )
    rgb = np.asarray(rgb_image, dtype=np.float32) / 255.0
    pixels = rgb[np.asarray(mask) > 0]
    hsv = rgb2hsv(pixels.reshape((-1, 1, 3))).reshape((-1, 3))
    hue, saturation, value = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    filters = {
        'purple': (hue >= 0.67) & (hue <= 0.88) & (saturation > 0.22) & (value > 0.16),
        'orange': ((hue <= 0.12) | (hue >= 0.98)) & (saturation > 0.46) & (value > 0.34),
        'lime': (hue >= 0.17) & (hue <= 0.40) & (saturation > 0.38) & (value > 0.34),
        'iceWhite': (saturation < 0.20) & (value > 0.58),
        'nearBlack': value < 0.16,
    }
    anchors: dict[str, dict[str, object]] = {}
    for name, selected in filters.items():
        selected_pixels = pixels[selected]
        if selected_pixels.size == 0:
            continue
        median = np.median(selected_pixels, axis=0)
        channels = np.clip(np.round(median * 255), 0, 255).astype(np.uint8)
        anchors[name] = {
            'hex': f'#{channels[0]:02X}{channels[1]:02X}{channels[2]:02X}',
            'rgb': channels.tolist(),
            'matchedSourcePixels': int(selected_pixels.shape[0]),
            'note': 'Median of matching visible source pixels; includes rendered lighting.',
        }
    return anchors


def _crest_crop(source: Image.Image) -> Image.Image:
    # Exact source pixels with a feathered polygon, not a replacement/generated logo.
    box = (285, 285, 895, 740)
    crop = source.convert('RGBA').crop(box)
    points = [
        (80, 75), (270, 20), (450, 65), (565, 160),
        (548, 305), (420, 430), (215, 445), (45, 340), (10, 185),
    ]
    mask = Image.new('L', crop.size, 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(2.0))
    crop.putalpha(mask)
    return crop


def _write_source_faithful_svg(vector_svg: Path, atlas: Image.Image, output: Path) -> None:
    svg = vector_svg.read_text(encoding='utf-8')
    buffer = io.BytesIO()
    atlas.save(buffer, format='PNG', optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
    layer = f'''\
        <g id="JAX_SOURCE_EXTRACTED_TEXTURE" clip-path="url(#JAX_GARMENT_CLIP)"
           data-provenance="front supplied; back and side views synthesized before UV extraction">
            <image id="JAX_SOURCE_FAITHFUL_ATLAS" x="0" y="0" width="1132.2" height="1460.56"
                   preserveAspectRatio="none" xlink:href="data:image/png;base64,{encoded}"/>
        </g>
'''
    marker = '\t\t<g id="branding">'
    if marker not in svg:
        raise ValueError('Could not find SVG texture insertion point')
    output.write_text(svg.replace(marker, layer + marker, 1), encoding='utf-8')


def _write_illustrator_compatible_svg(source_svg: Path, output: Path) -> None:
    """Remove private Adobe data and unavailable font dependencies for Illustrator."""
    svg = source_svg.read_text(encoding='utf-8')
    svg, foreign_count = re.subn(
        r'\s*<foreignObject\b.*?</foreignObject>',
        '',
        svg,
        count=1,
        flags=re.DOTALL,
    )
    svg, pgf_count = re.subn(
        r'\s*<i:aipgf\b.*?</i:aipgf>',
        '',
        svg,
        count=1,
        flags=re.DOTALL,
    )
    if foreign_count != 1 or pgf_count != 1:
        raise ValueError('Expected one Adobe foreignObject and one private PGF payload')

    # With the private branch gone, unwrap the root switch and make the standards-
    # based SVG group the direct document content Illustrator imports.
    svg = svg.replace('<switch>', '', 1).replace('</switch>', '', 1)
    svg = svg.replace(' i:extraneous="self"', '', 1)

    # Momentec's template contains hidden placeholder text using proprietary fonts
    # (RedSoxNationNormal and BriquetSub). Illustrator resolves hidden font objects
    # during import and reports an unknown-problem error when those fonts are absent.
    # They are decoration-location examples, not part of the customer artwork.
    # The exact visible typography is already inside the embedded four-view texture.
    # Remove every live SVG text object from this font-free delivery variant so
    # Illustrator never invokes a font resolver during open/import.
    svg = re.sub(r'\s*<text\b[\s\S]*?</text>', '', svg)
    svg = re.sub(r'\s+font-family="[^"]*"', '', svg)
    svg = re.sub(r'font-family:\s*[^;}]+;?', '', svg)
    output.write_text(svg, encoding='utf-8')


def build(
    source_path: Path,
    back_path: Path | None,
    left_path: Path | None,
    right_path: Path | None,
    base_texture_path: Path,
    vector_svg_path: Path,
    atlas_path: Path,
    crest_path: Path,
    palette_path: Path,
    source_faithful_svg_path: Path,
    illustrator_svg_path: Path | None,
) -> None:
    source = Image.open(source_path).convert('RGBA')
    atlas = Image.open(base_texture_path).convert('RGBA')
    width, height = atlas.size

    # Front body: source shoulders/torso mapped to Momentec's front-body UV panel.
    front = _warp_quad(
        source,
        [(238, 105), (964, 105), (942, 1092), (258, 1092)],
        _scale_points([(20, 20), (550, 20), (550, 585), (20, 585)], width, height),
        atlas.size,
    )
    # The 3D asset already has independent collar/lace geometry. Removing the
    # photographic collar pixels here prevents a second printed neckline.
    _erase_polygon(
        front,
        _scale_points(
            [(180, 0), (390, 0), (382, 92), (346, 125), (225, 125), (188, 92)],
            width,
            height,
        ),
        feather=7.0,
    )
    atlas.alpha_composite(front)

    # Refill the removed printed neckline with a source-derived purple fabric patch.
    x0 = round(180 * width / VIEW_W)
    x1 = round(390 * width / VIEW_W)
    y0 = 0
    y1 = round(125 * height / VIEW_H)
    neck_patch = source.crop((700, 215, 870, 360)).resize(
        (x1 - x0, y1 - y0),
        Image.Resampling.LANCZOS,
    )
    neck_mask = Image.new('L', neck_patch.size, 0)
    patch_width, patch_height = neck_patch.size
    ImageDraw.Draw(neck_mask).polygon(
        [
            (0, 0), (patch_width, 0), (patch_width, patch_height * 0.70),
            (patch_width * 0.80, patch_height),
            (patch_width * 0.20, patch_height), (0, patch_height * 0.70),
        ],
        fill=255,
    )
    neck_mask = neck_mask.filter(ImageFilter.GaussianBlur(7.0))
    neck_patch.putalpha(neck_mask)
    atlas.alpha_composite(neck_patch, (x0, y0))

    if back_path is not None:
        back = Image.open(back_path).convert('RGBA')
        back_panel = _warp_quad(
            back,
            [(280, 75), (978, 75), (958, 1178), (292, 1178)],
            _scale_points([(590, 25), (1125, 25), (1125, 585), (590, 585)], width, height),
            atlas.size,
        )
        _erase_polygon(
            back_panel,
            _scale_points(
                [(755, 0), (945, 0), (938, 72), (900, 94), (800, 94), (762, 72)],
                width,
                height,
            ),
            feather=7.0,
        )
        atlas.alpha_composite(back_panel)

    # Wearer's left sleeve is image-right and contains the supplied number 23.
    left_source = Image.open(left_path).convert('RGBA') if left_path else source
    left_quad = (
        [(490, 250), (748, 286), (690, 1148), (495, 1148)]
        if left_path
        else [(856, 168), (1050, 198), (1165, 1038), (928, 1056)]
    )
    left_sleeve = _warp_quad(
        left_source,
        left_quad,
        _scale_points([(20, 590), (558, 590), (550, 1055), (20, 1055)], width, height),
        atlas.size,
    )
    atlas.alpha_composite(left_sleeve)

    # Wearer's right sleeve is image-left. The production UV panel is reversed.
    right_source = Image.open(right_path).convert('RGBA') if right_path else source
    right_quad = (
        [(390, 285), (650, 275), (655, 1145), (488, 1145)]
        if right_path
        else [(165, 198), (354, 166), (286, 1055), (68, 1038)]
    )
    right_sleeve = _warp_quad(
        right_source,
        right_quad,
        _scale_points([(1070, 1060), (475, 1060), (475, 605), (1070, 605)], width, height),
        atlas.size,
    )
    atlas.alpha_composite(right_sleeve)

    atlas.save(atlas_path, optimize=True)
    _crest_crop(source).save(crest_path, optimize=True)
    palette_path.write_text(
        json.dumps(
            {
                'schema': 'journeyax.source-extracted-palette.v1',
                'source': source_path.name,
                'method': 'median-cut quantization inside a garment-only polygon',
                'semanticAnchors': _semantic_palette(source),
                'colors': _garment_palette(source),
            },
            indent=2,
        ) + '\n',
        encoding='utf-8',
    )
    _write_source_faithful_svg(vector_svg_path, atlas, source_faithful_svg_path)
    if illustrator_svg_path is not None:
        _write_illustrator_compatible_svg(source_faithful_svg_path, illustrator_svg_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--back', type=Path)
    parser.add_argument('--left', type=Path)
    parser.add_argument('--right', type=Path)
    parser.add_argument('--base-texture', required=True, type=Path)
    parser.add_argument('--vector-svg', required=True, type=Path)
    parser.add_argument('--atlas', required=True, type=Path)
    parser.add_argument('--crest', required=True, type=Path)
    parser.add_argument('--palette', required=True, type=Path)
    parser.add_argument('--source-faithful-svg', required=True, type=Path)
    parser.add_argument('--illustrator-svg', type=Path)
    args = parser.parse_args()
    build(
        args.source,
        args.back,
        args.left,
        args.right,
        args.base_texture,
        args.vector_svg,
        args.atlas,
        args.crest,
        args.palette,
        args.source_faithful_svg,
        args.illustrator_svg,
    )
    print(args.atlas)
    print(args.source_faithful_svg)
    if args.illustrator_svg is not None:
        print(args.illustrator_svg)


if __name__ == '__main__':
    main()
