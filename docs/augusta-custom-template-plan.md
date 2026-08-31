# Custom Design → New Template → All Sizes — The Plan (simple)

*MomenTech Brands / Augusta CDL. No code. This is the clean plan; the Scene7/existing-design detail is in the appendix only.*

---

## The idea in one line

**A customer brings a custom design → the system mints a NEW template (cut pieces for every size + all the config as JSON) → renders a proof → exports print-ready files per size → an artist signs off.**

---

## The core model

```
  BLOCK LIBRARY            NEW TEMPLATE (per design)              OUTPUT
  (built once)             = geometry + config, one JSON
  ┌──────────────┐         ┌───────────────────────────┐        ┌──────────────┐
  │ hockey jersey│──pick──▶ │ pieces: front/back/sleeve │        │ proof (2D/3D)│
  │ pant         │  block   │        graded to S/M/L/XL │──────▶ │ per-size PDF │
  │ cap …        │          │ zones · logos · text · art│        │ per-size .ai │
  └──────────────┘          └───────────────────────────┘        └──────────────┘
   parametric, reusable      created NEW every design             artist reviews
```

Three moving parts. That's the whole system:

| Part | What it is | How often built |
|---|---|---|
| **1. Block library** | Parametric base garments (jersey, pant, cap). Each is a *formula* that outputs cut pieces for any size. | **Once per garment type** |
| **2. Template builder** | Takes a block → generates the template's geometry (all sizes) → you add zones + logo/text slots + decoration → save as one JSON. | **New every design** |
| **3. Logo editor** | Upload a messy logo → clean → vectorize → place at a slot → approve. | Runs per logo |

---

## The template — one JSON object (geometry **and** config)

```json
{
  "templateId": "rink-rippers-hockey-2026",
  "block": "hockey-jersey",
  "sizes": ["S", "M", "L", "XL"],
  "pieces": {                                  // ← GEOMETRY (from the block, graded per size)
    "front":  "geom/front.svg",
    "back":   "geom/back.svg",
    "sleeveL":"geom/sleeveL.svg",
    "sleeveR":"geom/sleeveR.svg",
    "collar": "geom/collar.svg"
  },
  "zones":     [ { "name": "body",    "color": "VEGAS GOLD" },
                 { "name": "accent1", "color": "NAVY" } ],
  "logoSlots": [ { "anchor": "chest",     "asset": "logo_123.svg", "maxWidth": 180 } ],
  "textSlots": [ { "anchor": "back-name",   "font": "HARDBALL", "value": "RIPPERS", "color": "GOLD" },
                 { "anchor": "back-number", "font": "HARDBALL", "value": "23" } ],
  "allOverArt":{ "image": "art/cracks.png", "fit": "cover" }
}
```

- **Geometry + config live together.** This *is* "the template."
- **Editable + versionable.** Change a color or the logo → new version, re-render.
- **All sizes = this JSON × the per-size geometry.** Never scale one image.

---

## The flow: customer upload → all sizes

```
Customer (chat, no drag-drop)
  1. "hockey jersey, gold + navy, team RIPPERS #23, this crest, this pattern"
        │  upload logo + all-over art
        ▼
  2. Pick block → generate geometry (all sizes)          [Seamly2D]
  3. Logo → LOGO EDITOR (clean → vectorize → place)      [VTracer/potrace + Illustrator]
  4. Assemble the template JSON (geometry + config)
        ▼
  5. Render proof (2D + 3D) from the JSON                [Three.js / Blender]
  6. Customer approves in chat
        ▼
  7. Export per-size files: size-S/M/L/XL .pdf + .ai     [Adobe Illustrator (API or script)]
  8. Artist reviews / overrides → production
```

Step 7 is a **place → clip → export loop** over the template's per-size geometry. That's the "make these pieces in various sizes" part.

---

## Tool stack (open-source + Adobe Illustrator, no Optitex)

| Job | Tool | Cost |
|---|---|---|
| **Block library + template geometry** (cut pieces, all sizes, graded) | **Seamly2D / Valentina** (parametric pattern CAD, DXF/SVG out) | Free |
| **Graphics prep + editable/print export** | **Adobe Illustrator** (+ **Illustrator API / Firefly Services** for headless per-size export) | Adobe (you want it) |
| **Logo editor** (vectorize + place) | **VTracer / potrace** + Illustrator | Free / Adobe |
| **3D proof** | **Three.js** (in-browser, already yours) or **Blender** (rendered) | Free |
| **Template storage** | **JSON** (geometry refs + config) + asset storage | Free |
| **Print & cut alignment** (registration marks) | **Inkscape / ezdxf**, or the cutter's own software | Free |

---

## Where JourneyAX sits

JourneyAX's 40/60 chat is the **front door + control panel**, nothing more:
- collects the upload, colors, name, number, logo, all-over art (by talking, not dragging)
- assembles the **template JSON**
- triggers **render** (proof) and **export** (per-size files)
- routes to the **artist** for sign-off

The chat drives the JSON. The JSON drives everything else.

---

## Build phases (simple)

| Phase | Goal | Done when… |
|---|---|---|
| **0. One block** | Build ONE parametric block (hockey jersey) that outputs cut pieces for S/M/L/XL | Seamly2D block grades to 4 sizes, exports SVG |
| **1. Template + proof** | Chat → template JSON → 2D/3D proof | A customer can color it, add name/number, see it render |
| **2. Logo editor** | Upload logo → vectorize → place at a slot | A custom crest lands cleanly on the chest |
| **3. Per-size export** | Template JSON → 4 print-ready files + editable .ai | Artist opens the files and confirms usable |
| **4. More blocks** | Add pant, cap, etc. | Catalog of garment types grows |

---

## The honest constraints (running the factory)

1. **You can't auto-draft an arbitrary NEW garment shape from an image.** Real patterning. → geometry always comes from a **parametric block**; a brand-new garment *type* is a one-time build, a new *design* is automatic.
2. **Custom logos are garbage-in** (phone photos, PDFs). → the logo editor's vectorize + approve gate is mandatory.
3. **Screen color ≠ dye color.** → map colors to a real ink book, human approves.
4. **Sizes re-project by anchor, not scale** (name stays 8 cm below the collar on every size).
5. **Artist overrides everything** — production authority stays human (matches the requirement).

---

## What you build vs what's automatic

- **Build once:** the **block library** (parametric garments) + the **logo editor** + the **template builder** (JSON assembler) + the **export loop**.
- **Automatic per order:** geometry generation (block → all sizes), template JSON, proof render, per-size export.
- **Human per order:** logo/color approval + artist final review.

---

## Appendix — existing Augusta/Scene7 design (reference only, not the build)

Augusta already runs an Adobe **Scene7 / Dynamic Media** web-to-print pipeline for its *predefined* styles (the `service.augustasportswear.com/w2p/api/is/preview-prod-{style}-{size}` URL; named zones `SUB_FIRST_*`, text slots `t2/t7/t8`, an `all-over pattern` layer; colors by name). JourneyAX already drives it (`apps/product-service/src/render.service.ts`; AUG-21/23/30).

**This is a reference, not the plan.** For a new launch, don't reverse-engineer or depend on it. The plan above stands alone: parametric block → new template (geometry + JSON) → logo editor → render → per-size export. If Augusta later wants their *existing* Scene7 styles supported too, the same template JSON can target Scene7 params instead of Seamly2D geometry — but that's an optional add-on, not the foundation.

*(Deeper research + market landscape, if needed: `docs/augusta-ai-cutpiece-research.md` and `docs/augusta-illustrator-integration-deepdive.md`.)*
