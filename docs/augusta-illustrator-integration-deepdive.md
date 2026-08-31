# Adobe Illustrator Integration Deep-Dive — Uploaded Design → All Sizes (S/M/L/XL)

*MomenTech Brands (Augusta / Under Armour) CDL. Research + plan only — no code. Companion to `docs/augusta-ai-cutpiece-research.md`. Anchored on the live w2p URL the client provided.*

---

## 0. The headline: you are not starting from zero — Augusta already runs an Illustrator→web pipeline

The URL you pasted is not a random preview. **Decoded, it is an Adobe Scene7 / Dynamic Media "web-to-print" (w2p) render call** — and it reveals that Augusta's *production* jersey template is **already an Adobe Illustrator artwork, authored per size, published to Scene7, with named editable elements.** JourneyAX already drives this exact API (`apps/product-service/src/render.service.ts`, tasks AUG-21 / AUG-23 / AUG-30).

That changes the question. It is **not** "how do we build size grading in Illustrator from scratch." It is **"how do we connect a customer's uploaded custom design to Augusta's existing per-size Illustrator/Scene7 templates, and get editable Illustrator files back out."** Most of the hard part (graded per-size artwork, named color zones, text slots, live render) **already exists.**

---

## 1. What the URL actually says (decoded)

`https://service.augustasportswear.com/w2p/api/is/preview-prod-228130-l?…`

| Fragment | Meaning |
|---|---|
| `w2p/api/is` | **Adobe Scene7 Image Serving** ("is") — Adobe Dynamic Media's web-to-print render engine |
| `preview-prod-228130-l` | Template **product 228130**, size **L**. The `-l` suffix = size code → **`-s`, `-m`, `-l`, `-xl` templates exist per size.** This is the per-size Illustrator artwork already graded. |
| `s7:colorName='NAVY' … colorspace='defined'` | **Scene7 named color** from Augusta's *defined color library* (a color book). Colours are applied **by name**, no hex published (see `tooling-scene7-ink-probe`). |
| `setElement.SUB_FIRST_BODY_COLOR = <fill><SolidColor …/></fill>` | Recolor a **named vector region**. `SUB_FIRST_BODY_COLOR` = VEGAS GOLD, `SUB_FIRST_BUTTON_COLOR` = NAVY, `SUB_FIRST_ACCENT_1` = NAVY. These are the **design-line color zones** = named Illustrator objects. |
| `setElement.t2 = <content><p><span>Anurag Team</span></p></content>` + `setAttr.t2 = {visible=true & colorName=VEGAS GOLD & strokeColorName=NAVY & fontFamily=I.F.C. HARDBALL & horizontalScale=0.81 & fontSize=96.56 & weight=1.875 & x_movement=0 & y_movement=0.5}` | **Text element `t2`** (team name) with font, fill, stroke, horizontal scale, size, weight, and **x/y placement offsets** — i.e. free-flow position + typography, live. |
| `t7 = "00"`, `t8 = "Player Name"` | **Number** and **player-name** text slots (roster). |
| `setAttr.all-over pattern = {visible=true}`, `setAttr.swatch = {visible=true}` | **Layer visibility toggles** — including an **`all-over pattern` layer** (this is the hook for custom full-bleed art — see §4). |
| `fmt=png`, `wid=2000` | Output PNG, 2000px wide. |

**What this proves about Augusta's stack:**
1. The template is **vector, authored in Adobe Illustrator**, then published to Scene7. Scene7 vector templates are authored/round-tripped as **FXG** (Flash XML Graphics) — Illustrator's native export for Scene7. The **named layers/objects in the Illustrator file *become* the `setElement`/`setAttr` handles** (`SUB_FIRST_*`, `t2/t7/t8`, `all-over pattern`).
2. **Per-size graded artwork already exists** (the `-s/-m/-l/-xl` variants). The non-uniform grading (the FR-08 trap) is **already solved by whoever authored the templates** — you target the right size, you don't compute the grade.
3. There is an **`all-over pattern` image layer** — a place to inject custom full-bleed artwork, per size.
4. **JourneyAX already speaks this protocol** — the render connector emits exactly these params for the live configurator.

---

## 2. The Illustrator ↔ Scene7 relationship (how "editable Illustrator + live render" already coexist)

```
   Augusta artist (Adobe Illustrator)
        │  authors jersey template: named layers
        │  (body color, accents = SUB_FIRST_*; text boxes t2/t7/t8;
        │   an all-over-pattern image layer), one per graded size
        ▼
   Publish to Scene7 / AEM Dynamic Media  (FXG vector template)
        │  named objects → parameterized elements
        ▼
   Scene7 Image Serving  (w2p/api/is)  ── the URL ──►  live PNG render
        ▲
        │  setElement/setAttr per color zone, text slot, layer, size
   JourneyAX render.service.ts  (already built: AUG-21/23/30)
```

This is exactly the requirement's dual demand — **"editable Adobe Illustrator working file"** (§9) *and* **"live 3D/2D proof from the same artwork"** (§10) — and Augusta already satisfies it for **predefined** styles. The named elements are the editable layers; the Scene7 render is the live proof; the per-size templates are the size-specific files. **The requirement's §8 "cut-piece template registry" is, in Augusta's world, the Scene7 template catalog (per style, per size, named zones + anchors + version).**

The CDL gap is only this: today the zones are **fixed and pre-authored**; CDL wants **free-flow / uploaded** artwork. That gap is narrower than it looks (§4).

---

## 3. What "make all sizes in Adobe Illustrator" really means here

Two very different readings — be clear which one is being asked:

| Reading | What it takes | Reality for Augusta |
|---|---|---|
| **(a) "Produce a per-size editable Illustrator file for a chosen design"** | Reuse the existing **per-size template `.ai`/FXG** and apply the design's colors/text/art to each size | **Mostly already exists.** The `-s/-m/-l/-xl` templates *are* the graded Illustrator files. Applying a design = set the same named params against each size. |
| **(b) "Grade a brand-new custom pattern into all sizes from one flat image"** | Re-project free-flow art onto each graded cut-piece per size (non-uniform), seam-match, bleed | **The hard part** — this is the CDL free-flow case; needs the all-over-image hook (§4) + artist, and depends on the UV↔cut-piece gate from the companion doc. |

The winning move is to make **(a) the default** (fast, reuses Augusta's own graded Illustrator templates) and treat **(b)** as the artist-assisted extension. Grading is *authored*, not *computed* — you never scale one PNG across sizes (FR-08); you drive each size's own template.

---

## 4. The two integration modes for a customer's uploaded design

### Mode A — Parametric (reuse the existing named zones) ← do this first
The uploaded concept is **decomposed** (see companion doc §3/§6) into: body color, accent colors, logo, team name, number, player name. These map **1:1 onto the template's existing named elements** and are driven per size:

- colors → `setElement.SUB_FIRST_BODY_COLOR / ACCENT_n` (matched to Augusta's named color book)
- text → `setElement.t2 / t7 / t8` with font + placement
- logo → the logo/swatch layer
- **for each size** → the same params against `preview-prod-{style}-{s|m|l|xl}`

**Output:** live Scene7 render per size **instantly** (JourneyAX already does this), and the **editable Illustrator source per size already exists** (the template `.ai`/FXG) — the artist opens it, the named elements carry the customer's values. This is the "seconds" path and it's ~90% built.

### Mode B — Free-flow CDL (custom all-over artwork)
When the design is genuinely custom full-bleed art (e.g. the Rink Rippers cracked pattern) that doesn't reduce to named color zones, use the **`all-over pattern` image layer** the URL already exposes:

1. Prepare the approved art as a **print-ready image per size** (with that size's cut-piece bleed — companion doc §5).
2. Inject it as the size template's all-over layer (Scene7 `setElement.{allOverImage}=<image href=…>` / image-layer parameter), `setAttr.all-over pattern={visible=true}`.
3. Overlay named text/logo (`t2/t7/t8`, logo) on top per size.
4. **Illustrator output:** the per-size template `.ai` with the placed all-over image **linked** + editable text/logo layers → artist finishes (seam continuity, exact fonts, color).

Mode B is where the companion doc's raster→vector + UV↔cut-piece work lives; Mode A is where the fast wins are.

---

## 5. Adobe Illustrator automation options (the "integrate Illustrator" menu)

Since the client explicitly wants Adobe in the loop (paid path — a deliberate choice vs the earlier free stack), here are the real options, what each does, cost, and where it fits:

| Option | What it does | Runs where | Cost | Best for |
|---|---|---|---|---|
| **Adobe Scene7 / AEM Dynamic Media (w2p)** ← already in use | Parameterized **live render** of the per-size Illustrator template (the URL). Named zones, text, image layers, per size. | Adobe cloud (Augusta's existing tenant) | Already licensed by Augusta | **Mode A** live proof + the customer-facing render. The cheapest win — it's already paid for and wired. |
| **Illustrator API (Firefly Services)** | **Headless** cloud REST/async jobs: **Image Trace** (raster→vector SVG), **Rendition** (export PDF/PNG from `.ai`), **PDF import**, **document manipulation** (data-merge-style edits). | Adobe cloud | Enterprise, credit-based (contact-sales; no public rate) | The **official server path** to generate/edit `.ai`/PDF without a desktop — logo vectorization + per-size export in a SaaS. |
| **ExtendScript (.jsx)** | Legacy JS automation of **desktop** Illustrator: open template, place linked art, recolor named objects, retype text, multi-artboard, export AI/PDF per size. | A machine with **licensed desktop Illustrator** | Illustrator license(s); build free | **Mode B batch** generation in-house (artist workstation or a controlled runner). ⚠ Adobe has **no official "Illustrator Server"** — desktop-automation-at-scale is a ToS grey area (unlike InDesign Server). |
| **UXP scripting / plugins** | Modern replacement for ExtendScript (Illustrator 2022+): JS + APIs, panels, batch actions. | Desktop Illustrator | Illustrator license | Same as ExtendScript but current/supported; artist-side tooling + a "generate all sizes" panel. |
| **Variables / Data-Driven Graphics (XML)** | Bind template objects to **variables**, drive a **dataset** (per player, per size, per colorway) to batch-emit variants. | Desktop Illustrator (or scripted) | Illustrator license | **Roster + size batch** — one template, many outputs (matches your roster track, AUG-32). |
| **FXG round-trip** | Illustrator ↔ Scene7 template authoring format (named layers ↔ `setElement` handles). | Illustrator + Scene7 | Existing | Keeping the Illustrator source and the Scene7 template **the same object** (satisfies §10 "same template version"). |

**Recommended split:** **Scene7 (Mode A live render, already yours)** for the customer-facing "seconds" proof + **Illustrator API (Firefly Services)** for headless logo-vectorize and per-size `.ai`/PDF export in the SaaS, with **ExtendScript/UXP** as the artist-side "generate all sizes / finish" tooling. Reserve **Variables/XML** for roster batch.

---

## 6. How the JourneyAX conversational 40/60 drives Illustrator

The chat layer never opens Illustrator for the customer — it **drives parameters**, exactly as it already does for the live render:

```
Customer (chat, no drag-drop)              JourneyAX                         Adobe
──────────────────────────────   ────────────────────────────   ─────────────────────────
"navy body, gold accents"     →  render.service setElement.*   →  Scene7 live PNG (per size)
"team name Anurag, #00"        →  setElement.t2/t7/t8           →  Scene7 live PNG
"use this all-over pattern"    →  prep raster + all-over layer  →  Scene7 (Mode B)
─────────────  "approve → generate the artist package"  ─────────────
                                 job manifest (§12)            →  Illustrator API / ExtendScript:
                                 targets preview-prod-{style}     per-size .ai + PDF + linked art
                                 -{s,m,l,xl}                      → artist opens, finishes, releases
```

So the conversation produces the **same named-parameter set** that (1) renders live in Scene7 for the proof and (2) is applied to each per-size Illustrator template to emit the editable files. One source of truth, two consumers — which is precisely the requirement's §10 "3D model, cut-piece geometry, and Illustrator template must use the same style/size/template version."

---

## 7. Per-size mechanics (why this satisfies FR-08 without the grading trap)

- **Grading is authored, not scaled.** The `-s/-m/-l/-xl` templates each carry the correctly graded panel geometry and anchor points. JourneyAX targets the right size template; it never resamples one flat image (FR-08 satisfied by construction).
- **Anchors preserve intent across sizes** (FR-09). `t2/t7/t8` and logo placement use the template's per-size anchors (chest center, back center, sleeve center) — a name "8 cm below collar" stays there on every size because each size template defines that anchor.
- **Seam continuity** (FR-10) for all-over art is the artist's finish in Mode B; the template's named-zone geometry already respects seams for Mode A.
- **Same template version** across render + Illustrator + (future) 3D (§10) — enforced by keying everything to `preview-prod-{style}` + size + template version in the job manifest.

---

## 8. Recommended plan (mapped to the deck's MVP phases)

- **Phase 0 — Illustrator/Scene7 template audit (do first).** For **one** UA style, confirm: (a) the `-s/-m/-l/-xl` Scene7 templates exist and are the graded production artwork; (b) the matching **editable `.ai`/FXG source** files exist and their named layers == the `setElement` handles; (c) the `all-over pattern` layer accepts an injected image; (d) the 3D UV map matches the same template version (the companion doc's gate + deck slide 5 "critical dependency"). **This audit answers deck slide 10's "inputs needed from Augusta."**
- **Phase 1 — Mode A end-to-end (fast).** Chat → decompose upload → drive named zones/text per size in Scene7 (live proof, already built) → **"approve → generate"** emits per-size `.ai`/PDF from the existing templates via Illustrator API/ExtendScript → artist opens + confirms. This is a demoable POC that reuses Augusta's own production files.
- **Phase 2 — Mode B (custom all-over).** Raster→vector for logos (Illustrator API Image Trace), print-ready per-size all-over image with bleed, inject into the all-over layer, artist seam-finish. Add anchor rules + bleed automation + warnings.
- **Phase 3 — Scale.** Variables/XML roster batch; optional Firefly Services credits budget; revisit 3D proof from production artwork (Optitex-for-Illustrator style) once Mode A/B are proven.

---

## 9. What to get from Augusta (Illustrator-specific asks)

Beyond the deck's Phase-0 list, specifically for the Adobe integration:
1. The **editable `.ai` / FXG source** for one style's `-s/-m/-l/-xl` templates (not just the Scene7 render).
2. The **named-element dictionary** per template: exact object names (`SUB_FIRST_*`, `t2/t7/t8`, the all-over layer name), anchors, and which are locked vs editable.
3. The **Scene7 / AEM Dynamic Media account** access + whether **Illustrator API (Firefly Services)** is licensed on their Adobe tenant, and its credit budget.
4. The **defined color library** (Augusta's named color book) behind `colorName='NAVY'` etc. — needed to map an uploaded design's colors to production inks (no hex is published; see `tooling-scene7-ink-probe`).
5. The **all-over image layer spec**: accepted image format, resolution, and how bleed is expected inside it, per size.
6. Confirmation of the **desktop-Illustrator automation policy** (is a scripted runner acceptable, or must Illustrator steps stay on an artist workstation) — because Adobe has no official Illustrator Server.

---

## 10. The honest limits (Adobe-specific)

- **Adobe is paid**, deliberately — this is the opposite of the earlier zero-cost path. But the biggest license (Scene7/Dynamic Media + the Illustrator templates) **Augusta already owns and pays for**, so new spend is mainly Illustrator API (Firefly Services) credits + any extra Illustrator seats. Frame it as *leverage what they own*, not buy new.
- **No official Illustrator Server** — headless per-size generation should go through **Illustrator API (Firefly Services)**; desktop ExtendScript/UXP at scale is a ToS grey area. Keep desktop scripting artist-side.
- **Mode B still hits the companion doc's gate** — custom all-over art per size only auto-generates cleanly if the all-over layer's geometry corresponds to the graded cut pieces / UV. Where it doesn't, it's artist-finished (which the requirement explicitly allows — "artist remains the production authority").
- **Colors are by name, not hex** — mapping an uploaded design's arbitrary RGB to Augusta's defined color book is a lookup/approval step, not a direct value set.

---

## 11. The Optitex "Print & Cut" workflow — the production spine, and where Illustrator + JourneyAX plug in

Optitex **Print & Cut** is the canonical on-demand cut-and-sew production pipeline, and it is a near-perfect fit for CDL: Optitex positions it for *"micro-factory sample production, print-on-demand custom graphics/logos, efficient alignment of complex graphics, and small + mixed orders… in-house digital printers, sublimation and direct prints."* That is **exactly** an Augusta custom-team order — small, mixed sizes, custom graphics, sublimation. Crucially, **its Step 2 is Adobe Illustrator** — confirming Illustrator is *the* graphics-handoff point in the real production chain, not an add-on.

### The 5 Optitex steps mapped to the requirement + Augusta's stack

| Optitex Print & Cut step | Tool | Requirement (§6 / §8) | Augusta today | Where JourneyAX + AI fits |
|---|---|---|---|---|
| **1. Make the pattern** | Optitex **PDS** (2D/3D CAD) | §8 cut-piece registry; §6 step 3 (template load); graded per size | Augusta's graded patterns (the `-s/-m/-l/-xl` templates are the published face of these) | JourneyAX consumes patterns; does **not** make them |
| **2. Prepare graphics for printing** | **Adobe Illustrator** | §9 Illustrator working file; §6 steps 4–7 (decompose → place → generate) | The Scene7/Illustrator per-size templates + named zones | **THIS is the integration point.** AI concept intake + decomposition + the Scene7 named-param set feed Illustrator graphics here (Mode A/B, §4) |
| **3. Create marker + Print & Cut output** | Optitex **Marker** | §6 step 6 (cut-piece projection, **seam alignment**, bleed); §10 (registration) | Optitex/Gerber/Lectra marker (if used) | JourneyAX hands off artist-ready graphics; Marker does the **alignment + registration** |
| **4. Print the fabric** | Digital fabric printer / sublimation | production | Augusta production | — |
| **5. Cut the pieces** | Single/multi-ply cutter | production | Augusta production | — |

### The three things this settles

1. **"How do the graphics become cut pieces" has a bought answer — you don't build a cutter pipeline.** Optitex **Marker** does step-3 "efficient alignment of complex graphics" — it lays the Illustrator graphics onto the real pattern pieces and generates **Print & Cut files with registration marks** so the cutter cuts each printed panel exactly. That *is* the production form of the requirement's seam-continuity + cut-piece-projection (§6 step 6, §10). The requirement's deck (slide 8) already says this: **build the mapping IP internally, "buy/integrate" the apparel engine.** Optitex Print & Cut is the "buy" for steps 1, 3, 4, 5.
2. **Illustrator (step 2) is the shared boundary — and it's where JourneyAX stops.** JourneyAX owns the *front* of step 2: conversational AI intake → decompose the uploaded concept → drive Augusta's Scene7 named zones/text/all-over layer → produce **artist-ready Illustrator graphics** per size. From there the artist + Optitex (Marker) carry it to the cutter. JourneyAX **feeds** Optitex; it does not replace it. This keeps the requirement's "artist remains the production authority" intact.
3. **This resolves the UV↔cut-piece gate cleanly for a Print & Cut shop.** If Augusta runs Optitex (or Gerber/Lectra), the **cut pieces are the source of truth (DXF/PDS)** and graphics are aligned to them in **Marker** — so you don't need the 3D UV map to be the production authority at all; the 3D is only a *customer proof*. The gate from the companion doc matters for *automated projection*; in a Print & Cut shop, **Marker is the alignment authority** and the free/automated projection is optional acceleration, not a blocker.

### Build vs buy (settled by this)

- **Buy / integrate (production):** Optitex **PDS + Marker + Print & Cut** (or Augusta's existing Gerber/Lectra equivalent) for pattern → marker → registration → print → cut. Also Optitex **3D Design for Illustrator** if they want 3D proof *inside* Illustrator.
- **Build (the proprietary JourneyAX IP):** the **conversational AI-concept → artist-ready Illustrator graphics** front end — intake, decomposition, Scene7 parametric drive (Mode A), all-over injection (Mode B), the proof loop, the job manifest. This is the differentiator the deck calls out; the production chain below it is bought/existing.
- **Cost note:** Optitex is **paid enterprise CAD** (PDS/Marker/3D-for-Illustrator; contact-sales, no public price). Big apparel makers usually already run one of Optitex/Gerber(AccuMark)/Lectra — **so confirm which CAD + marker system Augusta already owns** before assuming a new Optitex purchase. If they already have a Print & Cut-class marker, the integration is "feed it good Illustrator graphics," which is exactly §4 Mode A/B.

**Key ask added for Augusta:** *Which pattern/marker CAD do you run today — Optitex, Gerber AccuMark, or Lectra? Do you already use a Print & Cut (registration-mark) marker workflow for sublimation?* The answer decides whether step-3 alignment is bought-and-present (just feed it Illustrator files) or a gap to close.

---

## Appendix — grounding in the existing codebase

The Scene7 w2p protocol is already implemented and proven in JourneyAX (so Mode A is a short reach, not new R&D):
- `apps/product-service/src/render.service.ts` — emits `setElement.SUB_FIRST_BODY_COLOR/ACCENT_n`, `setElement.t2/t7/t8`, `s7:colorName` SolidColor XML, `preview-prod-{style}-l` texture, `setAttr.{designLine}={visible=true}`. Comment (line ~18): *"`preview-prod-{style}-l` is NOT a finished flat photo. It IS the texture."*
- Tasks: **AUG-21** (garment render connector: Scene7 texture + print3d cameras), **AUG-23** (per-template render zones — un-hardcode `t2/t7/SUB_FIRST_*`), **AUG-30** (decoration capture: palettes, design lines, zones, text slots from the platform APIs).
- Memory: `tooling-scene7-ink-probe` (colours applied by name publish no hex — render an ink and read pixels back), `project_augusta_configurator` (client-side Three.js over per-SKU geometry).

*Open input: the client shared a YouTube reference (`youtube.com/watch?v=X2QnmxEUWg0`) that could not be fetched (bot-blocked). If it demonstrates a specific Illustrator automation/variable-data/w2p technique, that would refine §5's recommended option — worth a 2-line summary from the client.*
