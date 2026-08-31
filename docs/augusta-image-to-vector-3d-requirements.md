# JourneyAX Augusta image-to-vector-to-3D requirements

Status: implementation blueprint and validated proof of concept  
Audience: Momentec/Augusta product, art, e-commerce, platform and JourneyAX engineering teams

The complete tenant-configurable product and implementation requirements, including missing-view generation, Illustrator-safe exports, font preflight and authoritative all-size controls, are defined in [JourneyAX configurable garment design flow requirements](./journeyax-configurable-garment-flow-requirements.md).

## 1. Outcome

JourneyAX should let a customer upload a garment idea, identify the correct Augusta product construction, turn the visual idea into editable artwork, preview it on the approved 3D garment, personalize a roster, and submit a production-ready package for approval.

The platform must keep four artifacts separate:

1. **Reference image** — inspiration or a photographed garment; never authoritative geometry.
2. **Editable artwork** — logos, patterns, text, names and numbers in semantic layers.
3. **3D placement/UV atlas** — artwork aligned to one approved display model.
4. **Manufacturing pattern** — Augusta's graded, seam/bleed-aware cut pieces for each size.

The proof in `artifacts/augusta-three-hockey-designs` completes items 1–3. Item 4 is intentionally blocked until Augusta supplies its authoritative graded templates and print rules.

## 2. Validated style decisions

| Design brief | Correct construction | Augusta style | Decision |
|---|---|---:|---|
| Blue/black HOCKEY, MARNER 93 | Traditional lace-up hockey jersey | 228103 | Accepted; high-confidence construction match |
| Yellow/blue RATS, number 8 | Pro V/miter-neck hockey jersey | 228108 | Accepted; high-confidence construction match |
| Black/orange RINKSTER, number 87 | Pro V/miter-neck hockey jersey | 228108 | Accepted; high-confidence construction match |
| Any of the above on 227132 | Two-button short-sleeve baseball jersey | 227132 | Rejected |
| RATS/RINKSTER on 228187 | Reversible short-sleeve flag-football jersey | 228187 | Rejected |

Momentec's published hockey catalog describes 228103 as the traditional lace-up jersey and 228108 as the Pro V-neck jersey. The live configurator exposes 228108 as a model with V-neck hockey design lines. These two pieces of evidence are stronger than filename or image similarity.

## 3. What the live Momentec configurator establishes

The public configurator currently follows this business sequence:

1. Design
2. Color
3. Text & Logo
4. Roster
5. Summary

Its public client contract shows:

- model URL pattern: `https://static.momentecbrands.com/3D-Sublimation/{style}/{style}.glb`;
- normal-map pattern: `{style}-NormalMap.png` in the same style folder;
- design image service: `https://service.momentecbrands.com/w2p/api/is/preview-{style}_front`;
- design-line visibility is passed as named `setAttr` values;
- body/accent zones are named `setElement` values such as `SUB_FIRST_BODY_COLOR`;
- text and logo slots are semantic elements, not pixels; for the inspected hockey template, the defaults included number `t7`, player name `t8`, and logo `m12`;
- 3D render service accepts the generated texture as an input;
- the browser renderer assigns the primary atlas to material `main` and the reverse atlas to material `reverse`.

JourneyAX should implement this behind a **vendor adapter**. None of these names, URLs, design-line IDs, slot IDs or material names belong in conversation logic or React components.

## 4. Target journey

```mermaid
flowchart LR
    U["Customer uploads one or more reference views"] --> I["Intake and rights checks"]
    I --> C["Construction classifier"]
    C -->|"high confidence"| R["Product/model registry"]
    C -->|"uncertain or mismatch"| H["Human review gate"]
    H --> R
    R --> T["Normalize supplied views"]
    T -->|"views missing"| Y["Synthesize front/back/left/right concept views"]
    T -->|"all views supplied"| K["Four-view consistency gate"]
    Y --> K
    K -->|"duplicate neck, conflicting art or low confidence"| H2["Customer/designer review"]
    H2 --> K
    K -->|"approved"| V["Artwork decomposition and vectorization"]
    V --> S["Semantic layers: base, pattern, logo, text, roster"]
    S --> B["UV bake on approved GLB"]
    B --> Q["Automated 3D QA"]
    Q --> P["Customer front/back/side preview"]
    P --> A["Customer approval"]
    A --> G["Apply authoritative per-size graded templates"]
    G --> F["Augusta art and production proof"]
    F --> O["Order/roster submission"]
```

The conversation should summarize decisions and ask only for missing information. The 3D canvas should remain the primary work surface. A compact progress rail shows `Idea → Style → Artwork → Roster → Proof` without forcing the customer through a technical form.

## 5. Responsibility split

### Customer/user

- Upload every available view. A front view is sufficient to create a concept, while real back and side references remain the preferred production evidence.
- Approve any AI-synthesized back/side concept before vectorization. Synthesized views are proposals for unseen artwork, not factual recovery of the original garment.
- Choose or confirm sport, garment type, audience and preferred fit.
- Supply original logo/vector files when available and confirm rights to use all marks.
- Supply team colors using Pantone/brand standards where production accuracy matters.
- Upload the roster: player name, number, size, quantity and optional captain/goalie attributes.
- Approve garment match, reconstructed artwork, color proof and final production proof.

### JourneyAX automation

- Validate file type, dimensions, malware status, transparency and image quality.
- Extract visual features and classify construction before selecting a model.
- Resolve the product, model, material map, design lines, color zones and semantic slots from configuration.
- Stop invalid matches; never place a V-neck reference on a baseball or flag-football block merely because a GLB exists.
- When views are missing, synthesize a controlled four-view turnaround—front, wearer-left, back, wearer-right—before artwork extraction. Preserve the supplied view unchanged and label every generated view by provenance.
- Run a four-view consistency gate before vectorization: one collar/neck opening, one garment, correct construction, continuous side artwork, consistent sleeve numbering, readable approved text, and no mirrored/duplicated logos or laces.
- Remove background, normalize views, separate base colors/pattern/logo/text, and produce editable vector regions.
- Preserve personalization as variables; do not bake roster names and numbers permanently into the team artwork.
- Bake approved artwork to UV space, generate a GLB preview, render all required camera angles and calculate coverage/fit metrics.
- Track versions, approvals, source lineage, model/template hashes and generated artifacts.
- Route low-confidence, low-resolution, trademark, color or geometry failures to a human task.

### Augusta/Momentec and production art team

- Provide authoritative product-to-model mapping and licensing rules.
- Provide current GLB/OBJ, material mapping, normal maps and camera/display settings.
- Provide Illustrator/PDF/SVG manufacturing templates for every supported size, including grain, seam, bleed, safe zone, notches and panel IDs.
- Confirm whether sizes share UV topology. JourneyAX must not infer this.
- Provide color profiles, sublimation constraints, minimum line/text size and approved fonts.
- Review complex raster reconstruction and issue the final production proof.
- Return proof status, correction notes and production/order identifiers through an API or managed task.

## 6. Functional requirements

### FR-01 — Asset intake

- Accept PNG, JPEG, WebP, SVG, PDF, EPS and AI references according to tenant policy.
- Store the original unchanged; every derivative records the source hash.
- Require at least one construction-readable view; front is preferred. Request real back and side views when available.
- Assign per-view provenance: `supplied`, `synthesized`, or `approved_synthesized`, with source/model/prompt/version hashes.
- Missing side art must be handled by an approved synthesis/continuation step, never by blindly copying a front logo onto a sleeve.

### FR-01A — Missing-view synthesis and consistency gate

- If any of front, back, wearer-left, or wearer-right is missing, generate the missing concept views before vectorization or UV placement.
- Condition every generated view on the supplied reference, approved product construction, and already-approved views; preserve palette, fabric, print distress, collar, sleeve, seam, number, and logo relationships.
- Generate strict catalog/orthographic views with the full garment visible. Do not generate a body, mannequin, extra sleeve, extra neckline, extra collar, mirrored text, or additional branding.
- Treat the manufacturer GLB/OBJ as the construction and silhouette authority; generative imagery may propose artwork continuity but may not invent garment construction.
- Validate exactly one collar/neck opening across all views. If the 3D model has separate collar/lace geometry, mask the photographic collar/lace pixels from the diffuse atlas before applying those mesh materials.
- Validate front-to-side-to-back continuity, left/right orientation, sleeve-number placement, OCR text, and logo count. Failed checks regenerate once, then route to human review.
- Require customer/designer approval of synthesized views before they become vectorization inputs or production evidence.
- Never label synthesized views as manufacturer-supplied or source-exact. Preserve the supplied image unchanged beside the generated turnaround.

### FR-02 — Construction classification gate

- Classify neckline, sleeve length, closure, shoulder, body, reversible state, panel count and sport.
- Compare those features with the model registry.
- Return `accepted`, `needs_review`, or `rejected` with evidence.
- Thresholds and required features are back-office configuration per product family.

### FR-03 — Product/model registry

Store, version and expose:

- tenant, vendor and region;
- style, youth/adult/ladies equivalents and active date range;
- construction attributes and official sizes;
- source model URL, checksum and license status;
- geometry format, coordinate convention and scale;
- mesh/material roles (`main`, `reverse`, laces, hoops, trims);
- UV topology version, atlas dimensions and normal map;
- design-line IDs, color zones, text/logo slots and roster fields;
- per-size manufacturing-template ID and checksum;
- whether a size shares or changes UV topology;
- preview camera and lighting profile.

### FR-04 — Artwork decomposition

- Detect dominant colors and separate background, garment base, pattern, logos, text and player personalization.
- Preserve a locked reference layer alongside editable reconstruction layers.
- Trace flat artwork to vector paths with configurable color count and simplification tolerance.
- Mark photo-derived vectors as `concept` until a designer or brand owner approves them.
- Keep logos and text replaceable. OCR results are suggestions, not authoritative spelling.

### FR-05 — 3D placement

- Use the approved model as the geometry and silhouette authority.
- Compute UV islands from `TEXCOORD_0`; do not rely on hard-coded panel coordinates.
- Keep material-specific atlases separate. Applying one atlas to every material is prohibited.
- Bake front, back and approved side continuation into UV space.
- Generate the textured GLB, texture atlas, editable UV SVG and multi-angle preview.

### FR-06 — Roster personalization

- Import CSV/XLSX/API rosters using a configurable schema.
- Validate duplicate/missing numbers, allowed character sets, name length, font availability and product-size validity.
- Render text as dynamic vector objects using configured slots, font, stroke, scaling and collision rules.
- One approved base artwork should support the whole roster without rebaking the base design for every player.
- Produce a roster proof grid and exceptions report before order submission.

### FR-07 — Size handling

- Show official available sizes from the product registry.
- A display GLB may be reused for customer visualization only when explicitly configured.
- Manufacturing output for each size requires the matching authoritative graded template.
- The system must block production export if any ordered size lacks a template/checksum.
- Never generate manufacturing sizes by percentage scaling from L or another size.

### FR-08 — Color handling

- Maintain tenant/vendor swatch libraries and distinguish screen RGB preview from print target color.
- Store the selected named swatch, RGB preview, Lab/Pantone target and output profile.
- Run contrast/readability checks for numbers and names.
- Require a physical or vendor color proof where policy demands it.

### FR-09 — Review and approvals

- Approval stages: construction, artwork, color, roster, vendor art, production proof.
- Each approval records actor, timestamp, version and comments.
- Any change after approval invalidates downstream approvals based on dependency rules.
- Customer-facing status must explain what is waiting and who owns the next action.

### FR-10 — Export

- Concept package: SVG, PNG atlas, textured GLB, five-angle preview and manifest.
- Production package: authoritative per-size AI/PDF/SVG, linked vector artwork, fonts/outlines, color specification, roster data, seam/bleed validation and proof ID.
- All files must include style, design ID, version, size where relevant, and checksum.

## 7. Configurable back-office objects

The following must be data, not code branches:

- vendor endpoints and authentication;
- model URL patterns and asset proxy policy;
- product/construction taxonomy;
- allowed construction matches and confidence thresholds;
- accepted file types, limits and artwork-quality rules;
- mesh/material roles and UV channel;
- design lines, color zones, text/logo/roster slots;
- swatch libraries, fonts, strokes and placement constraints;
- required camera views and QA thresholds;
- available sizes and template availability;
- production bleed/safe-zone/line-size rules;
- approval workflow, SLA, pricing, MOQ and lead-time rules;
- retention, access, watermark and download policies.

## 8. Proposed service boundaries

| Service | Responsibility |
|---|---|
| Asset Intake | upload, validation, malware scan, metadata and immutable originals |
| Product/Model Registry | construction, styles, models, UV/materials and per-size templates |
| Artwork Intelligence | background removal, OCR, logo/pattern separation and vector reconstruction |
| Geometry/Retexture | render model views, UV bake, GLB and multi-angle output |
| Personalization | roster validation, semantic text/logo placement and roster proofing |
| Workflow/Approval | status machine, human tasks, customer/vendor approvals and audit |
| Vendor Adapter | Momentec W2P, configurator, asset and order/proof integration |
| Artifact Store | versioned originals, derivatives, manifests and signed delivery URLs |

Long-running vectorization/render work runs as idempotent jobs through a queue. The conversation API starts a job and streams progress; it does not hold an HTTP request open for minutes.

## 9. Suggested APIs

```http
POST /v1/design-jobs
Content-Type: multipart/form-data

front=<file>
back=<file optional>
sport=hockey
requestedStyle=<optional>
tenantId=augusta-us
```

```json
{
  "jobId": "dsg_01...",
  "status": "classifying",
  "nextEventUrl": "/v1/design-jobs/dsg_01.../events"
}
```

```http
GET /v1/design-jobs/{jobId}
POST /v1/design-jobs/{jobId}/confirm-style
POST /v1/design-jobs/{jobId}/roster
POST /v1/design-jobs/{jobId}/approvals/{stage}
POST /v1/design-jobs/{jobId}/production-export
```

Every job state includes `status`, `progress`, `blockingIssues`, `artifacts`, `metrics`, `approvals`, `sourceHashes` and `version`.

## 10. Quality gates and acceptance criteria

| Gate | Minimum acceptance |
|---|---|
| File quality | readable, malware-clean, configured pixel/vector threshold met |
| Construction | required garment features match; no rejected feature mismatch |
| Four-view consistency | front/back/left/right present; supplied/generated lineage recorded; one garment and one construction across all views |
| Neck/collar | exactly one visible neck opening and one configured collar treatment; no duplicate printed collar or laces beneath dedicated 3D meshes |
| Artwork continuity | side seams connect coherently; logos/text are not mirrored, duplicated or invented; sleeve numbers remain on the approved side |
| View fit | front/back silhouette IoU meets family threshold; current proofs achieved about 0.76–0.88 |
| UV coverage | configured exterior surface threshold met; gaps visible and flagged |
| Materials | main/reverse/trims receive only their configured atlas/material |
| Artwork | logo/text spelling reviewed; no accidental background, shadow or mannequin |
| Color | target swatches assigned; contrast rules pass |
| Roster | all rows valid; collisions and overflows resolved |
| Sizes | every ordered size has an authoritative, checksum-matched graded template |
| Proof | customer and Augusta production approvals recorded on the same version |

The current 228103 proof starts from one supplied front image and synthesizes back, wearer-left, and wearer-right concept views before UV extraction. It now gives materially better rear and side continuity and removes the duplicate printed neckline. Those three views remain AI-inferred proposals and require customer/designer approval; production should still prefer real views or an Augusta-approved continuation pattern.

## 11. Security, privacy and rights

- Scan uploads and parse vector/PDF files in isolated workers.
- Use signed, short-lived object URLs; never expose unrestricted vendor model or customer artwork buckets.
- Encrypt originals, rosters and artifacts in transit and at rest.
- Authorize access by tenant, project, team and approval role.
- Treat roster names and sizes as personal data; configure retention and deletion by region.
- Record customer attestation for logo/trademark rights and route disputed content to review.
- Strip unsafe SVG scripts, external references and embedded active content.
- Never send customer art to a third-party model unless tenant configuration and consent allow it.

## 12. Observability and performance

- Correlate conversation, design job, model version, template version and order IDs.
- Metrics: intake failures, classifier confidence, mismatch rate, vectorization duration, UV coverage, IoU by view, render duration, human-review rate, proof revisions and conversion.
- Alerts: vendor endpoint failures, model checksum changes, missing size templates, render timeouts, unusually low coverage, cross-tenant access attempts and stuck approvals.
- Cache immutable models/templates by checksum and reuse the approved base bake across roster rows.
- Initial targets: first status response under 500 ms, construction decision under 5 s, first preview under 30 s where assets are cached, full quality package under 2 min, with progress streamed throughout.

## 13. Delivery phases

### Phase 1 — Productionize the validated proof

- Add the registry entries for 228103 and 228108.
- Integrate the supplied Python pipeline as an asynchronous job.
- Add a missing-view synthesis job, prompt/version registry, four-view approval screen, and single-neck/continuity QA gate before vectorization.
- Add material-aware viewer loading and show coverage warnings.
- Add construction confirmation and human-review tasks.

### Phase 2 — Semantic artwork and roster

- Separate team artwork from names/numbers.
- Add roster schema/configuration, validation and proof grid.
- Add swatches, fonts and placement-slot configuration.

### Phase 3 — Manufacturing readiness

- Ingest authoritative graded templates for every size.
- Add seam, bleed, safe-zone, line-size and color-profile preflight.
- Integrate Augusta art/proof status and production export.

### Phase 4 — SaaS generalization

- Make product/model/vendor adapters tenant-configurable.
- Add model/template onboarding tools, automated regression fixtures and approval analytics.
- Support other sports and vendors without new product-specific UI components.

## 14. Definition of done

This capability is done only when a customer can upload a reference, receive the correct garment match, edit/approve the reconstructed artwork, preview the exact configured model, apply a validated roster, and export only the sizes for which Augusta has supplied and approved authoritative production templates—with complete lineage and approvals.
