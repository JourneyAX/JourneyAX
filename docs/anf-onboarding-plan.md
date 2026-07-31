# Abercrombie & Fitch — JourneyAX Onboarding & Fashion-Skills Plan

**Tenant:** A&F Co (multi-brand: Abercrombie, Hollister, abercrombie kids)
**Seed URL:** https://www.abercrombie.com/shop/us
**Vertical:** Retail fashion apparel (buy stock — NOT made-to-order / not team-personalised)
**Closest existing tenant:** Augusta (garment) — reuse ~70% of the garment path; drop roster/team; add fit + try-on + styling.

> Status when written: all apps down. This is analysis + plan only. Nothing executed.

---

## PART 1 — How JourneyAX onboarding actually works today (grounded in code)

The rails already exist. A new tenant is provisioned + fed by:

1. **Probe** — `apps/backoffice-admin/.../api/onboarding/probe` + `OnboardWizard.tsx`. Point it at a URL → detect platform, sitemap, product structure, brand.
2. **Provision project** — creates org + project with the config schema in `apps/project-service/src/project.types.ts`:
   - `ProjectScope` (categories, excludedSkus), `ContextDimension[]` (the classifier — schema literally ships a **Fashion example: `occasion` + `fit`**), `ProjectPricing` (currency/tax), `ProjectPersona` (systemName, greeting, **journeyGuidance**), `ProjectTheme` (colours/font/logo), `ProjectAiConfig` (provider/model/keys + separate `ingestModel`/`extractModel`), `ConfiguratorConfig`.
3. **Configure ingestion sources** — `IngestionSources.tsx` (config-driven, AUG-6/9): the catalogue URLs / feed / API to crawl.
4. **Ingest** — `packages/ingestion` (connectors → converters → storage → populators):
   - **connectors** = Playwright scrapers (AUG-1/2 removed Firecrawl; rich PDP extraction).
   - **converters** = normalise raw pages → product records.
   - **storage** = per-project GCS buckets for artifacts/images (AUG-8).
   - **populators** = write to the `documents` collection (tenant-scoped, `metadata.brand`/`metadata.sku`) + vectorise embeddings (AUG-43).
   - Knowledge `role`s already supported: `product | inventory | decoration | sizing | design | articles` — **`sizing` and `design` matter for fashion.**
5. **Reconcile** — feed vs scraped, dedupe (AUG-12).
6. **Capabilities** — toggle which panels the journey uses (`api.ts`): `products, accessories, installGuide, warranty, quote, choice, steps, configurator` (+ Augusta added `roster, teamColours`).
7. **journeyGuidance** — the per-project agent brain (goal/outcome statements the agent reasons over).
8. **Publish** — versioned publish lifecycle (B2).
9. **Journey runtime** — `agent-commerce-service`: intent-resolver → stage hints → journeyGuidance → panels (products / configurator / quote…). Money is server-authoritative (pricebook, P0-04).

**Takeaway:** onboarding A&F is 80% *config + ingestion* on existing rails. The genuinely NEW engineering is the fashion-specific skills (fit, try-on, styling panels).

---

## PART 2 — A&F fit: reuse vs new build

| Capability | Source | A&F status |
|---|---|---|
| URL probe → provision | AUG-4 | ✅ reuse |
| Playwright catalogue ingestion | AUG-2/6/7 | ✅ reuse (new PDP schema) |
| Products panel + cards | existing | ✅ reuse |
| Accessories → **complete-the-look** | AUG-10 outfitting sets | ✅ reuse, rename |
| Collections / outfit sets | AUG-10 | ✅ reuse |
| Cart / quote / Stripe checkout | P0-04 | ✅ reuse (simpler — retail cart, no BOM) |
| Context dimensions (occasion/fit/category/size) | schema ready | ✅ config |
| Per-project theme / persona / model | existing | ✅ config |
| **Fit / size recommendation** | — | 🔨 NEW skill + panel |
| **Virtual try-on (photo/video → garment on me)** | — | 🔨 NEW skill + panel + image-gen integration |
| **AI Stylist orchestration** | journeyGuidance | 🔨 config + light build |
| **Media upload (photo/video)** | MMS photo-audit is a starting point | 🔨 extend |
| Roster / team / per-player print | Augusta | ❌ DROP (not retail fashion) |

---

## PART 3 — Multi-brand (A&F + Hollister + kids)

Two viable models — **recommend Option A**:

- **Option A (recommend): each sub-brand = its own project under one org "A&F Co".**
  Mirrors MomenTech (Caroma + Augusta under one org). Each brand gets its own catalogue isolation (`metadata.brand`), theme (A&F minimalist B/W; Hollister beachy; kids playful), persona/stylist voice, and storefront. The storefront switcher lists them (as Caroma/Augusta today). Clean data isolation, independent publish, per-brand tone. Downside: 3× ingestion runs.
- **Option B: one project, `brand` as a context dimension.**
  Simpler infra, one catalogue with a brand facet. Downside: themes/voices bleed; harder isolation; not how the platform models tenants today.

→ **Start with ONE brand (Abercrombie US) end-to-end, then clone the recipe for Hollister + kids.** Prove the fashion journey once; the 2nd/3rd are config + re-ingest.

---

## PART 4 — Onboarding steps for A&F (the checklist to run when the system is up)

**Phase 0 — Recon (can partly do now, read-only):**
- Probe `abercrombie.com/shop/us`: platform (A&F is Salesforce Commerce Cloud-class SPA → needs Playwright + likely a JSON PDP/API endpoint), sitemap, PLP→PDP structure, size-chart pages, lookbook/"complete the look" blocks, media (multi-angle model shots).
- Decide catalogue scope for the demo (e.g. Men's + Women's tops/bottoms/outerwear — a few hundred SKUs, not the whole site).

**Phase 1 — Provision project `abercrombie`:**
- Org `A&F Co`; theme (black/white, A&F font, logo); persona = **"Abercrombie Stylist"**, greeting, escalation.
- Pricing USD. AI config (model + per-project key; `ingestModel`/`extractModel` for messy PDP layout).
- ContextDimensions: `occasion` (work/casual/party/date/vacation), `fit` (slim/regular/relaxed/oversized), `category` (tops/bottoms/dresses/outerwear/denim), `size`, `styleVibe` (clean/street/preppy).

**Phase 2 — Ingestion sources + run:**
- Sources: PLP URLs per category, PDP pattern, **size-chart pages**, **lookbook / outfit pages**, fit-guide/editorial articles.
- Ingest → capture the fashion PDP schema (see Part 5.0). Store model images in GCS. Vectorise product + article + sizing docs.
- Reconcile feed vs scrape; dedupe; spot-check 10 PDPs.

**Phase 3 — Capabilities + journeyGuidance:**
- Enable: `products`, `accessories`(complete-the-look), `quote`(cart/checkout), `configurator`(try-on/outfit canvas), + new `fit` + `tryOn` once built.
- Write journeyGuidance for the AI Stylist flow (Part 6).

**Phase 4 — Journey test + publish:**
- Test briefs: "outfit for a summer date, I'm usually a medium"; "what size in the slim-fit jeans, I'm 5'10 165lb"; "complete the look for this jacket".
- Publish (versioned).

**Phase 5 — Clone for Hollister + kids** (config + re-ingest).

---

## PART 5 — NEW fashion skills (the ideas, made concrete)

### 5.0 — Fashion PDP capture schema (foundation for all skills)
Ingestion must capture, per product: `sku, name, brand, category, subCategory, price, currency, description, materials/composition, care, variants[{size, colour, colourHex, inStock, imageUrl}], modelInfo (model height + size worn), fitNotes ("runs small"/"relaxed"), fitType, images[multi-angle], completeTheLook[skus], sizeChartRef, occasion tags, styleVibe`. This is richer than Caroma/Augusta and is the make-or-break for fit + try-on + styling.

### 5.1 — Fit / Size Recommendation skill  *(highest ROI — returns are fashion's #1 cost)*
- **Input:** height, weight, usual size + fit preference (or a body photo).
- **Data:** brand size charts (`sizing` role docs) + per-style `fitNotes`/`fitType`.
- **Logic:** map body inputs → chart → adjust by the garment's fit note ("this style runs small → size up"). Deterministic where possible (chart lookup), LLM only for the fit-note reasoning.
- **Panel (60%):** a "Your size: **M**" card with confidence + why + the measurement it's based on. 
- **Agent tool:** `recommendSize(sku, body)` → size + rationale. Blocks "add to cart" nudge until a size is chosen; reduces returns.

### 5.2 — Complete-the-Look / Outfitting skill  *(reuse AUG-10 sets)*
- **Data:** `completeTheLook` links + outfit sets + colour-harmony/style rules.
- **Logic:** given a chosen item + occasion + vibe, assemble a coordinated outfit (top+bottom+outerwear+shoes+accessory), each piece real + in-stock + size-matched.
- **Panel (60%):** an **outfit board** (the pieces stacked as a look) with a running total and "add the whole look to cart".
- **Agent tool:** `buildOutfit(anchorSku, occasion, vibe)`.

### 5.3 — Virtual Try-On skill  *(the "wow", the biggest new build)*
- **Input:** user uploads a **photo (or short video)**, or picks a body-type avatar / the closest model.
- **Approaches (pick by budget/quality):**
  - **(a) Model-match (fast, safe):** show the garment on the catalogue model whose body/size is closest to the user — no gen-AI, no PII risk. Good v1.
  - **(b) Generative VTON (the real demo):** garment-transfer diffusion model (e.g. an IDM-VTON / TryOnDiffusion-class service or API) renders the chosen garment onto the user's uploaded photo. Video = per-frame or a video-VTON model.
- **Panel (60%):** a **try-on canvas** — user image with the garment applied; swap size/colour re-renders; "try the whole outfit".
- **Guardrails (a real agent gate — reuse MMS photo-audit foundation):** consent + privacy (photos are PII — ephemeral, never trained on), face/body-safety moderation, image quality check, no minors misuse. This is a **blocking review agent**, exactly like MMS Artwork Review.
- **Agent tool:** `renderTryOn(sku, size, colour, userMediaRef)`.

### 5.4 — AI Stylist (orchestrator persona)
- The front-of-house voice. "Style me for a summer wedding, I'm a medium, budget $300." → understands occasion + fit + budget → builds an outfit (5.2) → sizes it (5.1) → shows it on the customer (5.3) → cart. Same orchestrator+gates pattern as MMS/Augusta.

### 5.5 — Media / Upload handling
- Accept photo + short video; store ephemerally (GCS, TTL), feed to fit (5.1 body estimate) + try-on (5.3) + styling ("what goes with what I'm wearing?"). Consent gate first.

---

## PART 6 — The journey experience (40/60) for fashion

- **40% chat = the AI Stylist** (understand → suggest → refine → try-on → size → checkout).
- **60% panel morphs by step:**
  - Products → product cards (with model images).
  - Complete-the-look → **outfit board**.
  - Fit → **size recommendation card**.
  - Try-on → **try-on canvas** (user photo + garment).
  - Cart → checkout.
- **Guided opening (the pattern we're refining on MMS):** Stylist opens by understanding intent (occasion / who / vibe / budget), then styles — not a search box.

**journeyGuidance sketch:** *"You are the Abercrombie Stylist. Open by understanding the moment (occasion, who it's for, their vibe, budget, usual size). Then build a complete look, not single items. Always recommend a size using the fit guide and the style's fit note before checkout. Offer to show it on the customer (try-on). Keep it aspirational but honest about fit and stock."*

---

## PART 7 — Risks / unknowns / decisions needed

1. **A&F site is a hardened SPA** — Playwright works, but a hidden PDP JSON/API is faster + cleaner; probe first. Bot-defences may throttle — scope the crawl, respect robots, cache.
2. **Try-on quality/cost** — generative VTON is compute-heavy + variable. **Decision:** ship model-match (5.3a) for v1 demo, wire a VTON API behind a flag for the wow.
3. **PII / consent** — user photos are sensitive. Ephemeral storage, explicit consent, moderation gate, no training. Non-negotiable.
4. **IP / brand assets** — use A&F's own product images (from their site) — never regenerate brand imagery.
5. **Multi-brand tone** — A&F ≠ Hollister voice; keep per-project personas.
6. **Sizing data availability** — need the real size charts + per-style fit notes ingested; without them, fit is guesswork. This is the critical ingestion target.
7. **Cart vs quote** — retail is a simple cart/checkout, not a BOM quote; reuse the order/Stripe path, drop the fixtures quote framing (watch for Caroma-template bleed, like CAP-6/the MMS quote bug).

---

## PART 8 — First 30 minutes once the system is up

1. Probe `abercrombie.com/shop/us` → confirm platform + find the PDP data endpoint + size-chart + lookbook URLs.
2. Provision project `abercrombie` (theme, persona=Abercrombie Stylist, USD, model/key, context dims).
3. Configure a scoped ingestion source set (2–3 categories) + run one small ingest; verify the fashion PDP schema captured (variants, sizes, model info, complete-the-look, size chart).
4. Enable capabilities `products + accessories + quote + configurator`; write the Stylist journeyGuidance; publish.
5. Drive one journey ("summer date outfit, medium, $300") → confirm products + complete-the-look + cart work on the reused rails.
6. THEN start the net-new builds in priority order: **Fit skill → Complete-the-look board → Try-on (model-match v1) → generative VTON behind a flag.**

**Sequencing rationale:** get A&F *shopping* on the reused garment/retail rails first (fast win, proves ingestion), then layer the three fashion differentiators. Fit first (returns = money), then the look (AOV), then try-on (wow/conversion).
