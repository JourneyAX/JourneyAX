# A&F Overnight Build — Morning Report

_Autonomous overnight run. Everything below is verified unless explicitly flagged._

## Headline
**The full Abercrombie & Fitch US catalogue is live: 4,429 products**, up from 153 — every
product crawled from the real site, enriched, ingested, and vectorized for retrieval.

## What shipped & is verified

### 1. Full catalogue (4,429 products)
- Source of truth: A&F's official product **sitemap** (`storeId=10051`) → 4,545 product URLs.
- Crawled with **8 parallel headed workers** (Akamai needs headed) in ~2.5h, **0 meaningful errors**
  (11 transient timeouts / 4,428 = 0.3%).
- Captured per product: name, **real price** (fixed a bug where JSON-LD nests price under
  `offers.priceSpecification[].price` — was falling back to a "$99" banner), colours + swatches,
  sizes, rating + review count, images, description, and **"Wear It With"** outfit sets.
- Loaded via the sanctioned pipeline (upsert-safe): **4,357 with colours, 4,151 with wear-it-with**,
  all **4,429 in the vector index** (searchable).
- Gender split: women 2,775 · men 1,535 · unisex 73 · **kids 45** (kids is small because A&F's US
  store lists few — `abercrombie kids` is a separate storefront).

### 2. Guided journey — verified across men / women / kids
- **Salesperson tone** (published, config v11): warm, decisive, presents a curated hero set first,
  then cross-sells, closes proactively.
- **Gender / occasion / fit / size clarify** fires correctly before showing products.
- Products come back **grounded** (real SKUs, prices, colours) — no hallucinated items.
- **Size pre-select:** the stylist sets `recommendedSize`; the card locks that size ("Your size" tag)
  instead of the full XXS–XXL row. (LLM-set, so occasionally omitted — best-effort.)
- **Recommendations are a 2nd step:** "Wear It With" moved off the grid card; it now appears when a
  shopper opens a product (detail view) — cross-sell/upsell as its own step. Data flows (`ctl=9–12`
  items per product with name + image + price).
- **Sale prices** (`~~was~~ now`) and **ratings** wired end-to-end.

### 3. Virtual try-on — built + verified (nano-banana)
- Provider-abstracted (`lib/tryon.ts`): **Gemini 2.5 Flash Image ("nano banana")** — the model
  analysis's top pick — with OpenAI `gpt-image-1` fallback.
- `/api/tryon` route (Vercel-ready: `nodejs`, `maxDuration 60`), `TryOn.tsx` upload→generate→result
  in the product detail view, with "AI preview, not a fit guarantee" + consent built in.
- **Verified end-to-end:** returned a real composite (garment onto a form). Deploy step: set
  `GEMINI_API_KEY` in the Vercel env for `journeyax-web`.

## Flagged honestly / next steps
- **Reviews (highest-value next):** A&F reviews are **Bazaarvoice** and directly fetchable (proven:
  769 reviews + 134 photos for one product). Blocker: the review API keys on a Bazaarvoice product
  id, not our SKU — needs a per-PDP id-capture pass first. Full plan in `docs`/memory. Rating + count
  (stars) already show today.
- **Virtual try-on** is a demo/"delight" feature — great wow moment, occasional artifacts; framed as
  a preview. Production path (PIM + sizing engine) in `docs/anf-virtual-tryon-spec.md`.
- **Duplicates:** 346 same-name groups exist but are almost all **legitimate variants** (e.g.
  "Premium Heavyweight 2.0 Tee" = 7 real colourways). Left as-is deliberately; only exact dupes
  (same name+price+image) should be cleaned, carefully.
- **Kids** catalogue is thin (45) by A&F's own US store; a fuller kids set needs the separate
  `abercrombie kids` storefront.
- `recommendedSize` is model-set and sometimes omitted — could be made deterministic from the
  clarify answer if we want it always present.

## How to demo
- Storefront: `http://localhost:3008/?project=abercrombie`
- Strong flows: **"a dress for a summer wedding, I'm a medium, elegant"** (women) and
  **"men's slim jeans for work, size 32, dark wash"** — both return grounded products with sizes,
  colours, and a "Wear It With" step when you open a product. Try-on lives in the product detail view.
