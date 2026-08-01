# Abercrombie & Fitch — Journey QA + Data-Quality Report

**Date:** 2026-07-30 · **Storefront:** http://localhost:3008/?project=abercrombie · **Catalogue:** 112 products, standalone mode
**Method:** live browser testing of every use-case journey (honest pass/fail, adversarial "should-fail" probes) + 4 parallel data-quality audit agents (product completeness, image validity, knowledge/retrieval, catalogue-vs-use-case). Every data figure below was measured, not estimated.

Verdicts: ✅ pass · ⚠️ works-but-flawed · ❌ fail.

---

## TL;DR

The **engine is genuinely good** — the guided clarify → grounded retrieval → bag → real Stripe checkout loop works and is honest for in-catalogue apparel. The **data is the ceiling.** Three things cap every use case:

1. **The catalogue is apparel-only and thin.** 112 products, **0 accessories, 0 shoes, 0 kids, 0 outerwear depth (3), 0 licensed/NFL.** This alone makes Complete-the-Look, Packing, Gift (kids), and Game Day *impossible on data*, not on code.
2. **No relevance floor in retrieval.** Every search returns 5 results regardless of match — so out-of-catalogue asks ("winter parka", "snow boots") don't get an honest "we don't carry that"; the journey proceeds and can hang or surface irrelevant items.
3. **Attributes are prose, not structured.** Colour hex is 100% null (no real swatches); denim has zero structured rise/wash/fit/length; care/measurements aren't queryable. So a real Denim Finder / colour filter / Fit Advisor can't filter on data — only on text.

---

## Live journey test matrix

| # | Scenario | Use case | Verdict | Headline |
|---|----------|----------|---------|----------|
| 1 | "linen shirt, summer wedding, I'm a large" | Stylist | ✅ | Clarify → real grounded look → bag → Stripe. Honest "not customisable". |
| 2 | "I want a blue shirt with pants" | Stylist / guided | ✅ | Now renders occasion/fit/size clarify (was dumping products — fixed today). |
| 3 | "usually medium, between sizes, do linen shirts run true?" | Fit & Size Advisor | ✅ | Cites size-up guidance + how-to-measure from ingested charts. Card: "Fit: Relaxed — size up if between sizes". |
| 4 | "I'm looking for baggy jeans" → Casual/L/Relaxed | Denim Finder | ⚠️ | Real relevant Baggy Jeans returned, BUT generic clarify (occasion, not rise/wash/length), **alpha size L instead of waist inches**, and **two identical "Baggy Jean $90" cards** (duplicate record). |
| 5 | "warm winter parka + waterproof snow boots for a ski trip" | Adversarial / out-of-catalogue | ❌ | Did NOT decline. Said "That sounds like a fun trip!" and ran the full clarify, then **hung in "Confirming stock" 60s+ with no resolution.** A&F stocks neither parkas nor boots. |

(Earlier verified this session: full stylist E2E to real Stripe checkout $517.05; commerce-mode segregation; grounding substitution.)

---

## Per-scenario detail

**#4 Denim Finder (the flagship near-term use case) — ⚠️ works as a generic stylist, not a denim finder.** Retrieval returned real, on-brief Baggy Jeans ($90, 100% cotton, vintage light wash, real model+product images, SKU 53267822) — grounding is solid. But three flaws, all data/config-rooted:
- The clarify asked **occasion / usual size / fit** — the deck's Denim Finder needs **rise / wash / fit(90s-athletic-baggy) / length / "do you size up in the waist"**. The dimension config is the generic stylist set.
- Size options were **XS–XXL (alpha)**. Jeans are sold by **waist inches** and the data stores sizes as "28","29","30"… — the clarify used the wrong scale, and the agent accepted "L" for jeans without mapping to a waist.
- **Two cards both "Baggy Jean $90"** — the image audit found a duplicate product record ("Menswear Relaxed Straight Trouser" pair); denim shows the same class of dup.

**#5 Winter parka + snow boots — ❌ the important failure.** The honest answer is "A&F doesn't carry ski parkas or snow boots — here's our warmest outerwear." Instead the agent affirmed the request, collected sizing, and stalled in the validating state. Root cause = **no relevance floor** (retrieval always returns 5) + **catalogue holes** (3 outerwear, 0 boots). This is the single most demo-dangerous behaviour: a customer can lead it into promising things that don't exist.

---

## Data-quality audit (4 parallel agents, all figures measured)

### A. Product completeness — *structurally solid, semantically shallow*
- Core fields **100% present**: parentSku (all unique), priceUSD.min ($19–$180, median $80), images, sizes, colors, variants, description (none < 40 chars), narrative. **No fakes, no placeholder SKUs, no dup parentSku.** Size↔variant integrity perfect.
- **[BLOCKER] Colour hex 100% null** — 451/451 colours and 1,038/1,038 variants have `hex: null`. No real swatch can render; colour filtering impossible. Colour exists only as text names.
- **[HIGH] Denim has zero structured attributes** — 17 denim SKUs, none carry rise/wash/fit/length fields; signals live only in prose (rise & length in just 8/17). A Denim Finder must run a prose-extraction back-fill first.
- **[HIGH] All 1,038 variants missing `upc`/`gtin`**, `priceUSD.cost` null — no barcode/margin data for real cart/fulfilment/feeds.
- **[MEDIUM] Taxonomy inconsistency** — 43 category strings from 112 products; exact hyphen dup ("Zip Up" vs "Zip-Up Hoodies"), parallel trees for tees/shirts/sweatpants → fragmented facets, mis-routed retrieval.
- **[MEDIUM] `sizeChartImages` + `swatchImages` empty on all 112.**
- Price stored in **whole dollars, not cents** (violates the platform cents convention — display-safe today, rounding risk later).

### B. Image/media validity — *actually healthy*
- **100% of 151 sampled image URLs resolve** (206, image/jpeg) server-side — **no Akamai/CDN blocking.** The earlier "blank images" was the commercetools mis-routing (fixed), never the images. 0 products with 0 images.
- `images[0]` is a clean packshot on **96.4%** (108/112 `_prod1`); 4 off-type (1 lifestyle crop, 3 on-model) look inconsistent as thumbnails.
- **[LOW-MED] 1 duplicate product record** — "Menswear Relaxed Straight Trouser" exists twice with identical images/name (shows as a duplicate card; matches the denim dup seen live).
- No swatch images anywhere → swatch UI must fall back to colour chips (and there's no hex — see A).

### C. Knowledge & retrieval — *works, but no relevance floor* (audit hit an API drop; partial but the key finding is confirmed live)
- **[HIGH] Every search returns 5 results with no relevance threshold** — confirmed live by the parka test. Out-of-catalogue queries return nearest-neighbour apparel instead of "nothing found", which is the hallucination/over-promise vector.
- Fit-knowledge retrieval (the 19 ingested docs) works: sizing/measure/care queries surface the right charts (verified earlier).

### D. Catalogue vs use-case readiness
| Use case | Verdict | Evidence |
|---|---|---|
| Denim Finder | **PARTIAL (strongest)** | 14 denim SKUs across 8+ fits; but ~1 SKU/fit, no structured rise/length |
| Fit & Size Advisor | **PARTIAL** | sizes 100%, "true to size" flag; **no per-garment measurements** (charts are images, not data) |
| AI Stylist | **PARTIAL** | 53 tops/31 bottoms/25 dresses/3 outerwear — apparel looks yes, "complete" look no |
| Gift Concierge | **PARTIAL** | good $19–180 spread; **0 kids/teen**, 0 giftable accessories |
| Discovery | **PARTIAL** | rich text within apparel; breaks on accessories/kids/outerwear |
| Complete-the-Look | **NOT-READY** | **0 accessories** — nothing to cross-sell to; will describe types or hallucinate |
| Trip/Packing | **NOT-READY** | no shoes, ~3 outerwear, no swim/active → can't pack head-to-toe |
| Game Day / NFL | **NOT-READY** | **0 licensed/collab SKUs** |
| Loyalty Concierge | **NOT-READY** | member/tier data lives outside the product catalogue |
| Post-Purchase Care | **NOT-READY** | explicit care on only 4/112; fabric % on 12/112 |

Division: Women's 70 / Men's 42 / **Kids 0**. Accessories **0**. Outerwear **3**.

---

## Ranked issues & recommendations

**Data (the ceiling — most journeys are data-blocked, not code-blocked):**
1. **[BLOCKER] Add accessories + shoes** (~30–50 SKUs). Unblocks Complete-the-Look and materially improves Stylist / Packing / Gift. Nothing else moves the roadmap as much.
2. **[BLOCKER] Colour hex 100% null** — ingest a name→hex map (or per-variant hex) so swatches and colour filters work.
3. **[HIGH] Structure the denim attributes** (rise/wash/fit/length) via a prose-extraction back-fill, and **use waist-inch sizing for jeans** — the two things standing between "generic stylist over jeans" and a real Denim Finder.
4. **[HIGH] Per-garment measurements feed** for the true Fit Advisor ROI (returns↓). Charts today are images, not queryable.
5. **[MEDIUM] De-dup the duplicate product record; normalise the taxonomy** (hyphen dup + parallel trees).
6. **[LATER] Kids line, licensed/NFL SKUs, structured care/fabric** — needed for Gift-kids, Game Day, Care; each is a data acquisition, not code.

**Code/behaviour (cheaper, high-leverage):**
7. **[HIGH] Add a retrieval relevance floor** — below a score threshold return "found: false" so the agent can honestly say "we don't carry ski parkas — here's our warmest layer" instead of over-promising and hanging. This is the single most important behaviour fix for demo safety.
8. **[MEDIUM] Denim-specific clarify config** (rise/wash/length + waist sizing) — mostly config on the engine we already have.
9. **[MEDIUM] Fix the validating-state hang** on unresolved journeys (timeout → graceful "couldn't find a match" instead of infinite "Confirming stock").
10. **[LOW] "Collection Collection" doubled label** (UI-derived, no `collection` field); off-type `images[0]` thumbnails (4/112).

**Lead the demo with:** Denim Finder (real multi-fit breadth) and Fit & Size Advisor (the ROI story) — the two use cases the current data actually supports. Guard against parka-style over-promising by adding the relevance floor first.
