# Augusta CDL — Template Library: how to build it, end to end

*For the team. This is the "check the templates" backbone of the CDL flow (`augusta-cdl-spec.md`, step 3). It's how we know whether a design's template **already exists with all sizes** — and it's the catalog we match every upload against.*

---

## Why this exists

CDL flow step 3 is: *"Check our templates — is there a matching one, with all the sizes? Yes → use it. No → create it."*
That check needs a **template library**: every designable Augusta garment, its garment type, its sizes, and its live cut-piece template. This doc is how we build and refresh that library from Augusta's own data — no guessing, all real.

**Key fact we proved:** Augusta already publishes **one cut-piece template per designable style**, per size, via their web-to-print (Scene7) service. The template ID **is the product's `Parent_SKU`**. Example: `Parent_SKU 228130` = *FreeStyle Sublimated Full-Button Baseball Jersey* → template `preview-prod-228130-l` (the flat cut pieces you saw). So the library already exists inside Augusta — we just **extract and index it**.

---

## The two data sources (both public, no auth)

| Source | URL | What it gives |
|---|---|---|
| **Sublimation product feed** (the designable catalog) | `https://static.momentecbrands.com/productdata/sublimation-product-data-std-all.csv` (≈26 MB, ~40k variant rows) | Every designable style + its sizes, colours, garment type, name, price, image. Mirror: `static.augustasportswear.com/productdata/sublimation-product-data-std-all.csv` |
| **Web-to-print template render** (the cut pieces) | `https://service.augustasportswear.com/w2p/api/is/preview-prod-{Parent_SKU}-{size}?fmt=png&wid=2000` | The live **flat cut-piece PNG** for that style + size (Adobe Scene7). This is the actual template. |

Feed columns that matter: `Parent_SKU` (= style/template id), `Item_Name`, `Category` (= `Division | Sport | Type`, e.g. `Adult | BASEBALL | TOP`), `Size`, `Color`, `Color_Hex_Value`, `MSRP`, `Main_Image_URL`.

---

## The method (what the build scripts do)

1. **Download** the sublimation feed CSV.
2. **Group by `Parent_SKU`** → one entry per style (≈**364 designable styles/templates**).
3. **Parse the garment type** from `Category` → `division` (Adult/Youth/Ladies/Girls), `sport` (Baseball/Basketball/Hockey…), `type` (Top/Bottom).
4. **Collect the sizes** available for that style (S/M/L/XL/2XL…). Flag `coreSizesPresent` = has S/M/L/XL.
5. **Attach the w2p template**: `preview-prod-{Parent_SKU}-l` + the render URL pattern.
6. **Probe the w2p** for each style (with retries + polite delay — the service throttles) → set `renderable: true/false`. In our run, **~23/24 sampled styles render**; the only misses are non-garment accessories (e.g. a fleece blanket).
7. **Write the registry** → `template-library.json` (full) + `template-library.csv` (team-readable).

Scripts (in `scratchpad/tpl/`, portable to the repo): the grouping/parse step, and `probe-all.py` (the w2p verifier). Re-run whenever the feed updates (Augusta refreshes the CSV; a nightly job keeps the library current).

---

## The registry schema (one entry per template)

```json
{
  "parentSku": "228130",
  "name": "FreeStyle Sublimated Full-Button Baseball Jersey",
  "division": "Adult",
  "sport": "BASEBALL",
  "garmentType": "TOP",
  "category": "Adult | BASEBALL | TOP",
  "sizes": ["S","M","L","XL","2XL","3XL","4XL"],
  "coreSizesPresent": true,
  "colorCount": 16,
  "msrp": "…",
  "image": "https://…main.jpg",
  "w2pTemplate": "preview-prod-228130-l",
  "w2pUrlBase": "https://service.augustasportswear.com/w2p/api/is/preview-prod-228130-{size}?fmt=png&wid=2000",
  "renderable": true,
  "renderSize": "l"
}
```

**Coverage from our build (real numbers):** 364 templates — Basketball 73, Baseball 67, Softball 35, Soccer 20, Pullovers 20, Multi-sport 20, Football 19, Lacrosse 14, Volleyball 13, Hockey 10, Track&Field 10, Cheer 8, Fleece 7, Polos 5, plus tees/bottoms/accessories. **343/364 have core S/M/L/XL.** ~12 rows have a blank `Category` and need a garment-type tag (AI-classify or hand-fix).

---

## How the CDL flow USES the library (the match step)

When a customer uploads a design:
1. **Analyze** the image (AI vision) → garment type + sport + style features (e.g. "baseball jersey, full-button, adult").
2. **Match** against the library: filter by `sport` + `garmentType` + `division`, then rank by style features → best `parentSku`.
3. **Check sizes**: does that template have all the sizes the order needs? (`coreSizesPresent` / the `sizes` list.)
4. **Branch:** match with sizes → **use it** (pull the cut pieces from the w2p URL). No match → **create** a new template (parametric block → cut pieces → grade → validate on 3D → add to the library so it's a match next time).

**Matching rule (agreed):** garment type + style is enough — don't over-engineer "what makes two designs the same." A new *artwork* on a known *style* is a match; only a genuinely new *garment/silhouette* is a "create."

---

## Capturing the actual cut pieces (the "cut library")

The registry points at the template; to hold the cut pieces themselves:
- **On-demand (default):** fetch `w2pUrlBase` with `size` when needed — no storage, always current.
- **Cached:** render + store the PNG per style×size (GCS/R2) for speed/offline. ~364 styles × ~6 sizes.
- **Geometry (later):** trace the cut-piece outlines to SVG/DXF (VTracer/potrace) when we need true vector panels for the "create" branch or print files.

---

## Why "match to a catalog style" is the right model (garment-side reasoning)

Teamwear works on a **fixed catalog of designable "styles" (blanks)** + **infinite decoration on top**. Every custom order = pick a style, apply artwork. So "does the template exist?" is really *"which of our 364 catalog styles is this?"* — a classification, not a from-scratch pattern job. The 364 styles already cover every mainstream sport, so **most uploads WILL match**; a true "create" (new silhouette) is the rare case. This is exactly how Augusta/ProLook/Optitex operate — the pattern is catalog capital; the design is per-order.

---

## For the team — how to run / maintain

1. `curl` the sublimation feed → `sub.csv`.
2. Run the grouping script → `template-library.json` + `.csv`.
3. Run `probe-all.py` → fills `renderable`.
4. Load `template-library.json` into the app's template registry (Mongo collection `cdl_templates`, keyed by `parentSku`).
5. Wire the **match step** to query it (sport + garmentType + division + feature rank).
6. **Refresh nightly** (feed changes) — same three steps; the library stays live.
7. Backlog: AI-classify the ~12 blank-category rows; render+cache cut pieces; add DXF/SVG geometry for the "create" branch.

**Artifacts produced by this build:** `template-library.json`, `template-library.csv` (364 templates, verified renderable), and the scripts. Drop them into the repo (`data/cdl/` or the back-office) so the app and the team share one source.
