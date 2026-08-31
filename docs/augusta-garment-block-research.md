# The Garment Side — Hockey Jersey Block, Cut Pieces & Sizing (research)

*MomenTech Brands / Augusta CDL. No code. Companion to `docs/augusta-custom-template-plan.md`. This is the "block" half of the plan: how a jersey is actually built, and how one parametric block outputs cut pieces for every size as data.*

---

## The target (from the Rink Rippers sample slide)

The client's own slide frames the whole value prop:

> **AI concept (flat image)  →  production-ready artwork.**
> Limited tools = **3+ hrs manual, "directional accuracy."**  AI tools = **<15 min, high accuracy.**

The example is a **hockey jersey**: lace-up collar, all-over "cracked" sublimated pattern, chest logo ("Rink Rippers"), sleeve number 23. So block #1 = **hockey jersey**, and "production-ready" means the design correctly mapped onto the real cut pieces, per size — which is what the block must produce.

---

## 1. The garment: what a hockey jersey is actually made of

In cut-and-sew, **every panel is cut flat, printed (sublimated), then sewn.** A hockey jersey is the panel-richest of the sports:

| Cut piece | Count | Note |
|---|---|---|
| Front body | 1 | Closed front (no placket) |
| Back body | 1 | **Longer** — drop-tail hem |
| Shoulder yoke | 1–2 | Often a separate contrast piece |
| Sleeves | 2 | **Set-in** (pro) or raglan (entry); often split upper+lower for stripes |
| Collar | 1 | Lace-up / rib crew / v-insert |
| Cuffs | 2 | Rib or self-fabric |
| Side inserts / gussets | 0–2 | Ventilation / mobility |
| Elbow reinforcement | 0–2 | Contact durability |
| Hem band | 0–1 | Sometimes weighted |

**Panel tiers:** entry ≈ 4 panels (front, back, 2 raglan sleeves); standard ≈ 5; pro cut-and-sew = 10–16 sewn elements. For sublimation you **print the colorblocking** instead of cutting separate colored fabric — fewer physical pieces, but **each piece needs bleed + seam-matched art**.

**Per-sport panel set** (for later blocks):

| Sport | Cut pieces |
|---|---|
| **Hockey** | front · back(drop-tail) · 2 sleeves(set-in) · shoulder yoke · lace collar · 2 cuffs · side gussets · hem |
| Baseball | **front L+R** (button placket) · back · 2 sleeves · placket facings · collar · cuffs |
| Soccer | front · back · 2 sleeves · V/crew collar · side vents |
| Basketball | front · back · 2 side panels · neck binding · 2 armhole bindings |

---

## 2. The one switch that changes the geometry: set-in vs raglan

This is the master toggle for the block:

| | **Set-in** (hockey pro, baseball, basketball) | **Raglan** (entry hockey, soccer, football) |
|---|---|---|
| Seam | horizontal armhole seam on the shoulder | diagonal collar→underarm seam |
| Pieces | **3**: front, back, +2 sleeves (curved cap matches armhole) | **2**: body (shoulder cut away) + sleeve carries the shoulder |
| Look | structured; graphics align to shoulder seam | roomy, bold two-tone shoulders; cross-shoulder art harder |

**For the block:** treat sleeve-attachment as a **top-level parameter** — it reshapes the body's upper edge *and* the sleeve's upper edge together. Hockey default = **set-in + shoulder yoke**.

---

## 3. The block: how one pattern outputs cut pieces for every size (as data)

Two free, mature, code-drivable toolchains do exactly "parametric block → per-size cut pieces as SVG/DXF":

| Tool | Model | Jersey base | Export | Automation | License |
|---|---|---|---|---|---|
| **Freesewing** | patterns as **JS code**; a design is a function of measurements → SVG | **Aaron** (athletic tank), **Teagan** (tee), **Hugo** (raglan), all from the **Brian** body block | SVG (1st-class); DXF via convert | **Fully headless in Node** — self-host, loop measurement sets → one SVG per size | **MIT (commercial OK)** |
| **Seamly2D / Valentina** | formula-driven points vs a measurement table; GUI draft | community t-shirt/raglan blocks; draft your own | **SVG + DXF-AAMA/ASTM** (industry cut formats) | Real **headless CLI** (`valentina --exportOnlyDetails`, per size) | GPLv3 (output yours) |

**Neither ships a "jersey" by name** — you author it once by extending a base block (athletic ease, knit negative-ease, define front/back/sleeve/collar pieces, seam allowance). Budget that as the one-time block build.

**Recommendation:**
- **Automated, code-driven pipeline (matches JourneyAX):** build the jersey as a **Freesewing design** (start from Aaron/Teagan, lift Hugo's raglan) → self-host `@freesewing/core` → loop the size measurement sets → **one SVG per size, headless.** MIT = commercially safe.
- **When a cutter needs industry DXF-AAMA:** reproduce/export through **Seamly2D's CLI**.
- **Pragmatic:** prototype geometry in Freesewing (fast, SVG), export production DXF via Seamly2D.

Each emitted panel carries: **net (sew) line + seam allowance (~6–10 mm) + bleed (~3–5 mm) + per-edge seam-partner/notch metadata** so sublimation art stays continuous across seams.

---

## 4. Sizing & grading: why it's never "scale the image"

**Grading = derive every size from a base by adding a *different* increment to each measurement.** Bodies widen faster than they lengthen, so the axes grade independently.

**Real hockey chart (Athletic Knit — the hockey standard, finished garment inches):**

| Size | Chest | Width(flat) | Body length | Sleeve |
|---|---|---|---|---|
| Youth S | 36–38 | 18 | 23 | 25 |
| Youth XL | 42–44 | 21 | 26 | 28 |
| Adult S | 41–43 | 21 | 30 | 30 |
| Adult M | 45–47 | 23 | 31 | 32 |
| Adult L | 49–51 | 25 | 32 | 33 |
| Adult XL | 53–55 | 27 | 33 | 34 |
| Adult 2XL | 55–57 | 28 | 34 | 35 |
| Adult 3XL | 57–59 | 30 | 35 | 37 |

**Two rules the data must encode:**
1. **Non-uniform.** M→L step = `width +2, length +1, sleeve +1` — three different numbers. A uniform 108% scale that fixed the chest would make the body ~2.8″ too long. This is *the* reason a block beats an image transform.
2. **Youth and adult are separate nests** (Youth-XL width 21 = Adult-S width 21, but length jumps 26→30). Never grade across the gap.

**Grade increments (ballpark):** chest +1–2″/size (more at XL–3XL) · body length +0.75–1.5″ · sleeve +0.5–1″ · neck +0.25–0.5″. Increments are **not constant** across the ladder — store per-step.

**The data shape (a jersey's size chart + grade, as JSON):**
```json
{
  "styleId": "hockey-jersey-pro", "unit": "in", "tolerance": 1.0,
  "measurementPoints": [
    { "key": "chest",  "type": "circumference", "patternFactor": 0.5 },
    { "key": "width",  "type": "flat_half",      "patternFactor": 1.0 },
    { "key": "bodyLength", "type": "length",      "patternFactor": 1.0 },
    { "key": "sleeveLength","type": "length",     "patternFactor": 1.0 }
  ],
  "nests": [
    { "nest": "adult", "baseSize": "M", "sizes": [
      { "size":"S","width":21,"bodyLength":30,"sleeveLength":30 },
      { "size":"M","width":23,"bodyLength":31,"sleeveLength":32 },
      { "size":"L","width":25,"bodyLength":32,"sleeveLength":33 },
      { "size":"XL","width":27,"bodyLength":33,"sleeveLength":34 } ] },
    { "nest": "youth", "baseSize": "M", "sizes": [ /* youth rows */ ] }
  ],
  "fitTypes": { "true":{}, "slim":{"chest":-2}, "relaxed":{"chest":+2} }
}
```
- `patternFactor 0.5` on circumference = each flat pattern half carries half the girth (stops uniform scaling).
- Fit types (slim/true/relaxed) = additive offsets → `sizes × fitTypes` cut-piece sets from one file.
- Goalie / women's / tall = their own nests, not offsets.

---

## 5. How this plugs into the plan

This is the **left half** of the template object from `augusta-custom-template-plan.md` — the `pieces` (geometry) and `sizes`:

```
BLOCK (Freesewing hockey jersey, built once)
   │  feed each size's measurement row  ── size chart JSON (§4) ──►
   ▼
per-size cut pieces (SVG/DXF, seam+bleed+notches)   ─── become ──►  template.pieces
   │
   └── + zones/logos/text/all-over art (the config half)  =  the full template
              │
              ▼
       render proof (2D/3D) + export per-size print files → artist review
```

So: **one hockey-jersey block + one size-chart JSON → cut pieces for S/M/L/XL on demand.** The design (colors, logo, number, all-over art) sits on top. "All sizes" is the block × the size rows — never a scaled image.

---

## 6. Honest limits (garment side)

1. **No tool ships a jersey** — you author the hockey block once (from Aaron/Teagan/Hugo). One-time cost per garment type.
2. **Knit behavior isn't automatic** — negative ease, rib/binding allowances are yours to encode.
3. **Freesewing DXF is second-class** — SVG is first-class; use Seamly2D for industry DXF-AAMA when a cutter needs it.
4. **Grade rules ≠ native** — both tools are measurement-driven; if Augusta owns grade tables, convert them to per-size measurement rows (charts in §4 seed real data).
5. **Seam continuity across raglan/side seams** is the hard art case; the block emits the seam-partner metadata, the artist confirms.

---

## Sources
Construction/cut-pieces: customjersey.com (cut-and-sew), athleticknit.com (hockey panels), wooter.com (raglan vs set-in), ninghow.com + customink.com (sublimation bleed/seam). Parametric CAD: freesewing.dev (core API, Aaron/Teagan/Hugo/Brian, MIT), github.com/FashionFreedom/Seamly2D + valentina CLI manpage. Sizing/grading: athleticknit.com/sizing-chart, static.augustasportswear.com (ASB size chart PDF), kobolabs.io + techpacker.com (grading = non-uniform).
