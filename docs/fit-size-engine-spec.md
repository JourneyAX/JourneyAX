# JourneyAX Fit & Size Engine — build spec (Option 1 rules + Option 3 crowd)

Not a Fit Finder integration. This is how JourneyAX builds size/fit recommendation
and full product variation (colour + size + variants) natively, using our own
ingestion pipeline + OpenAI, as part of onboarding and the journey.

---

## 0. Grounded reality (why this is needed)

A live A&F product today has ONLY: `title, type, sku, price, finishes, images,
imageUrl, specs, description, url, documents, content`.
**Missing: `colors`, `colorHex`, `sizes`, `variants`, `sizeCharts`, `fit`.**

Yet `packages/ingestion` already models all of it (`colour-size` populator with
hex, `variants` populator per-SKU, `sizeChartImages`). A&F was onboarded via a
thin CSV path that never ran those populators, so the product docs are flat.

**Consequence (all one root cause):**
- "Show more details / other colours / variations" → nothing to show (no variant axis).
- `getProductOptions` returns `found:false` → agent apologises.
- Card/bag can't show colour swatches; "size" only echoes the clarify answer.

**So there are two builds, in order:**
1. **Fix the data axis** — run every tenant through the full variant ingestion so
   products carry colours+hex, sizes, per-SKU variants, size charts. (Unblocks
   "more details / colours / variations".)
2. **Add the fit layer** — a per-garment-type size-metrics model + a `recommendSize`
   tool (Option 1 now, Option 3 later).

---

## 1. Data model

### 1a. Product variant axis (fix the flat data)
Populated by the EXISTING `packages/ingestion` populators — just make A&F/every
tenant use them. Target product shape:

```ts
interface Product {
  sku: string; title: string; category: string;
  garmentType: 'shirt' | 'pant' | 'hoodie' | 'dress' | 'skirt' | 'short' | ...; // NEW, normalised
  price: number;
  colors: { name: string; hex?: string; swatchImageUrl?: string; imageUrl?: string }[]; // colour axis
  sizes: string[];                       // e.g. ['XS','S','M','L','XL','XXL']
  variants: { itemSku: string; color: string; size: string; imageUrl?: string; inStock?: boolean; price?: number }[];
  sizeChartImages: string[];             // brand's published chart, if any
  media: { images: string[]; videos: string[] };
  // …existing fields…
}
```

Key: `variants` is the (colour × size) grid. `colors[].imageUrl` = the per-colour
product photo (fixes "all cards show the same photo" for variant colours).

### 1b. Size-metrics model (NEW — powers recommendSize Option 1)
Per **garment type**, a body-measurement → size table, plus brand fit tendency.
Stored as an ingested knowledge doc per tenant (reuses the knowledge-docs pipeline),
keyed `sizemetrics://{tenantId}/{garmentType}`:

```ts
interface SizeMetric {
  tenantId: string;
  garmentType: 'shirt' | 'pant' | 'hoodie' | ...;
  // The measurements that MATTER for this garment type (this is the crux):
  //   shirt/hoodie/dress → chest, (neck, sleeve for dress shirts)
  //   pant/short         → waist, inseam, hip
  //   skirt              → waist, hip
  measures: ('chest'|'neck'|'sleeve'|'waist'|'inseam'|'hip'|'height'|'weight')[];
  // rows: for each size, the body-measurement RANGE it fits (cm or in)
  chart: { size: string; ranges: Partial<Record<Measure, [number, number]>> }[];
  fitTendency: 'runs_small' | 'true_to_size' | 'runs_large';
  fitNotes: string;                       // "slim through the body; size up if between"
  // brand-offset map: "an M in {refBrand} ≈ {size} here"
  brandOffsets?: { refBrand: string; map: Record<string,string> }[];
  source: 'published_chart' | 'llm_bootstrap' | 'crowd_model';
  confidence: number;                     // 0–1; llm_bootstrap starts ~0.6
}
```

---

## 2. Ingestion — as part of onboarding

Two passes, both slot into the existing onboarding/ingestion job runner.

### Pass A — variant axis (deterministic, from the feed)
Run the existing `colour-size` + `variants` + media populators on the tenant's
catalogue feed (CSV/API). Requires the feed to carry Color / Color_Hex / Size /
Item_SKU columns (A&F's thin CSV did not — that's the fix). Output: populated
`colors/sizes/variants/sizeChartImages` on every product. **No LLM needed.**

### Pass B — size metrics (LLM-bootstrapped, then refined)
This is where "we're using OpenAI, we should have that knowledge" pays off.
For each garment type in the catalogue, an onboarding step calls OpenAI to
**generate a first-cut `SizeMetric`** grounded in three inputs we DO have:

1. the tenant's published **size-chart image/text** (if `sizeChartImages` exist → OCR/vision → real ranges);
2. the brand's **known fit reputation** (OpenAI general knowledge: "A&F runs slim");
3. **standard apparel body-measurement→size norms** per garment type (OpenAI general knowledge).

Prompt contract (structured output, one call per garmentType):
```
Given: brand={brand}, garmentType={type}, sizes={sizes},
       publishedChartText={ocr or null}.
Produce a SizeMetric: the measurements that matter for THIS garment type only,
a body-measurement→size table (prefer the published chart; else standard norms
adjusted for this brand's fit tendency), fitTendency, fitNotes, and a
brandOffsets map for 3–5 common reference brands. Never invent a published
measurement — if no chart, mark source='llm_bootstrap' and lower confidence.
```
Output → validated → ingested as `sizemetrics://{tenant}/{type}` knowledge doc.

**Honesty rule:** `source='llm_bootstrap'` is an APPROXIMATION. It is shown to the
brand in the back office for review/edit before publish, and is superseded by
`published_chart` (Pass A OCR) and later by `crowd_model` (Option 3). We never
present a bootstrapped size as a guaranteed measurement.

---

## 3. `recommendSize` — the agent tool

### 3a. Tool schema (added to the agent's tool set, universal like getProductOptions)
```ts
{
  name: 'recommendSize',
  description: 'Recommend a size for a specific product from the customer\'s body '
    + 'inputs and/or a garment they already own. Uses the tenant size-metrics; '
    + 'never guesses a measurement that is not recorded.',
  parameters: {
    sku: 'string (the product being sized)',
    // any subset the customer gave during clarify:
    height_cm?: 'number', weight_kg?: 'number', usualSize?: 'string',
    refBrand?: 'string', refSize?: 'string',     // "I'm an M in Uniqlo"
    fitPreference?: "'slim'|'true'|'relaxed'|'oversized'",
    bodyMeasures?: '{ chest?, waist?, inseam?, hip? }'   // if they know them
  }
}
```

### 3b. Port interface (resolves per tenant via AdapterRegistry — same pattern as knowledge/commerce)
```ts
interface SizePort {
  recommend(ctx, input: RecommendSizeInput): Promise<{
    found: boolean;
    size?: string;                 // the recommendation
    confidence: number;
    rationale: string;             // customer-facing: "A&F runs slim; you're between M/L → L"
    alternates?: { size: string; note: string }[];   // "size down for a slimmer fit"
    source: 'published_chart'|'llm_bootstrap'|'crowd_model';
  }>;
}
```
Registry picks the resolver by data availability (best → worst):
`crowd_model` (Option 3, if enough returns data) → `published_chart` → `llm_bootstrap`.

### 3c. Option 1 resolver (rules/chart — ships now, zero order data)
```
load SizeMetric(tenant, garmentType(sku))
1. if bodyMeasures given → look up the size whose ranges contain them (primary measure first).
2. elif refBrand+refSize given → apply brandOffsets map.
3. elif height+weight given → estimate primary measure from norms, then look up.
4. elif usualSize given → treat as our-brand size adjusted by fitTendency.
apply fitPreference (slim → size down one if borderline; relaxed → up).
return { size, confidence: metric.confidence * inputQuality, rationale, alternates }.
```
Deterministic. Rationale is generated from the metric (why this size), so it's
grounded, not an LLM guess.

### 3d. Option 3 resolver (crowd model — the moat, later)
Once a tenant has enough order + return outcomes THROUGH JourneyAX:
- Build a per-(garmentType) model: features = customer inputs (height/weight/
  usualSize/refBrand+size/fitPref); label = the size KEPT (not returned for fit).
- Collaborative-filtering / gradient-boosted classifier per garment type.
- `recommend()` returns the size most similar kept-shoppers landed on + confidence
  from sample size. Source='crowd_model', confidence rises with data volume.
- This is the data network effect: more sales → better sizing → fewer returns.
Cold-start guard: below N kept-orders for a (type,size) cell, fall back to Option 1.

---

## 4. Journey integration (where it fires + renders)

- **Clarify phase** already asks occasion/fit/size — extend the question set to
  optionally capture height/weight OR "your size in a brand you know" + fit pref.
- After the customer focuses/asks about a product (or at add-to-bag), the agent
  calls `recommendSize({sku, …clarify answers})`.
- **Render (fixes the gaps you flagged):**
  - Product card / focused detail: **colour swatches** (from `colors[].hex`) +
    **size pills** (from `sizes`) + **"Recommended for you: L — A&F runs slim"**.
  - Selecting a colour swaps `imageUrl` to `colors[].imageUrl` (real per-colour photo).
  - Bag line shows the chosen size + a "why" tooltip. Fills the "review your
    pieces and sizes" promise the cart currently can't keep.
- **Back office:** a Size Metrics tab per tenant — review/edit the LLM-bootstrapped
  charts, mark published vs bootstrap, see crowd-model confidence as it grows.

---

## 5. Build order

1. **Pass A** — run A&F (+ every tenant) through the variant populators so
   colours/sizes/variants/size-charts populate. Unblocks details/colours/variations.
2. **Card/detail render** — swatches + size pills + colour→image swap.
3. **Pass B** — LLM size-metrics bootstrap per garment type + back-office review.
4. **`recommendSize` tool + Option 1 resolver** — wire into clarify→recommend; show
   "Recommended: L".
5. **Option 3** — start logging order/return outcomes now; train per-tenant crowd
   models once volume exists; registry auto-upgrades the resolver.

Steps 1–4 need no order history and ship immediately. Step 5 is the durable moat
that turns each brand's own returns into better sizing over time.
