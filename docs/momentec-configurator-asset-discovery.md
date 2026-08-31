# Momentec Configurator Asset Discovery and Vector Reconstruction

## Purpose

This is the repeatable JourneyAX workflow for turning a public Momentec
Configurator URL plus customer artwork into an editable, size-specific SVG and
a verified 3D preview. The URL is the source of product identity; a photograph
is only a source of visual intent.

## Non-negotiable identity gate

Before generating artwork, extract and reconcile these values:

1. `partNumber` - physical garment style, for example `CUT_228162`.
2. `iNumber` - saved inspiration/configuration record.
3. `designLine` - selected design family.
4. Product name and sport shown by the configurator.
5. Style number embedded in every preview, model and production-template URL.

If any source uses another style number, stop and classify it as a separate
product. In the 228162 investigation, the supplied `preview-prod-228130-l`
endpoint was rejected because 228130 is a baseball jersey.

## Discovery sequence

### 1. Observe the rendered page and request inventory

Load the exact Configurator URL and capture the rendered DOM plus all observed
resource requests. Do not assume a GLB. The 228162 page exposed:

- `.../3D-Sublimation/228162/228162.obj`
- `.../3D-Sublimation/228162/228162.mtl`
- `.../3D-Sublimation/228162/228162-NormalMap.png`
- `.../svgfiles/preview-prod-228162-l.svg`
- `.../properties/228162.json`
- `.../getScene7Attributes?fileName=preview-228162`
- `.../getSublimationTemplates?styleName=228162&designLine=digipro`

The adapter must store URLs actually observed in the browser. URL-pattern
prediction may be used only as a candidate, followed by existence and content
validation.

### 2. Build a normalized style manifest

Persist a tenant/project-scoped record containing:

- provider and storefront identifiers;
- style, inspiration and design-line identifiers;
- product name, sport, adult/youth relationship and supported sizes;
- model format and model/material/normal-map URLs;
- production SVG URL per size;
- texture and render-service endpoints;
- color option IDs;
- text/logo placement IDs and allowed sizes;
- source URL, discovery timestamp and checksum for every downloaded asset.

This manifest, not provider-specific constants in UI components, is what the
JourneyAX tools consume at runtime.

### 3. Keep three artifacts separate

1. **Production vector** - authoritative cut geometry and editable artwork.
2. **Texture atlas** - rasterized output aligned to the model UV coordinates.
3. **3D model** - provider model using the generated texture.

One file must not pretend to be all three. The SVG remains the editable design
source; the PNG is regenerated from it; the model is only a preview surface.

## Semantic vector reconstruction

Never trace the complete customer photograph into thousands of incidental
paths. Rebuild the visual system as named layers:

- base colors;
- patterns and gradients;
- stripes, grids and accents;
- team/brand mark;
- editable team name;
- editable player name and number;
- sponsor/secondary marks;
- cut geometry and non-printing guides.

Clip the artwork to the production paths in the provider SVG. Use the
provider's placement IDs (`t*` and `m*`) as semantic anchors where appropriate.
Continue patterns deliberately across seams, then visually inspect every panel.

## Size handling

Measurements are not cut geometry. They support validation but do not justify
scaling one SVG into all sizes. For every supported size:

1. Discover the size-specific `preview-prod-{style}-{size}.svg`.
2. Verify that it is an Illustrator/source SVG and that its garment/style ID
   matches the requested product.
3. Reapply semantic artwork through named anchors or normalized panel-local
   transforms.
4. Render the size-specific texture.
5. Run edge, clipping, seam and placement checks.

If the authoritative SVG is unavailable, mark that size blocked rather than
inventing a grade rule.

## 3D verification gate

The pipeline must render at least front, front-quarter, side, back-quarter and
back views and verify:

- no mirrored text on the assembled garment;
- correct front/back orientation despite rotated flat panels;
- no artwork outside cut paths;
- acceptable pattern continuity across body and sleeves;
- readable player name/number at expected distances;
- model, texture and production SVG all carry the same style identity.

## JourneyAX implementation shape

Implement this as a provider adapter selected from back-office configuration:

```text
Configurator URL
  -> Identity Gate
  -> Provider Asset Discovery Adapter
  -> Style Manifest Registry
  -> Semantic Artwork Composer
  -> Size-specific SVG Exporter
  -> Texture Generator
  -> 3D Verification Renderer
  -> Human Art Approval
```

Recommended configurable fields:

- provider base domains and endpoint templates;
- allowed asset hosts;
- style-ID extraction rules;
- supported model formats (`glb`, `obj+mtl`);
- placement-role mappings (`playerNumber -> t7`, etc.);
- required production sizes;
- typography and brand assets;
- color palette and print tolerances;
- approval rules and provider-specific lead-time policy.

The agent decides when to invoke the capability. The adapter performs
deterministic identity, file and production-safety checks.

## Security and operational controls

- Fetch only public `https` assets from tenant-approved hosts.
- Block redirects to private networks or unapproved domains.
- Enforce MIME type, size and decompression limits.
- Sanitize SVG scripts, external references and event handlers before storage.
- Malware-scan uploaded logos and raster artwork.
- Keep source, generated and approved assets immutable and versioned.
- Record checksums, prompt/model versions, user approval and export history.
- Cache immutable source assets by checksum; revalidate mutable API responses.
- Never submit or save a design to Momentec without explicit user approval.

## Acceptance criteria

- A Configurator URL produces one normalized manifest with no conflicting style
  identities.
- The model and size-specific SVG are obtained from observed provider requests.
- Artwork is editable by semantic layer in Illustrator.
- Roster fields remain editable and data-driven.
- Every exported size uses an authoritative size template.
- A five-angle render proves UV orientation and placement.
- The result is labeled concept, review-ready or production-approved; these
  statuses are never conflated.
