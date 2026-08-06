# JourneyAX — Platform in a Nutshell (day-one technical brief)

For a new engineer/PM: what the platform *is*, what it does and doesn't do, why it isn't "just ChatGPT," and where it's going. Technical framing.

---

## 1. What JourneyAX is (one line)
**A multi-tenant, config-driven AI commerce platform that turns any brand's catalogue into a goal-driven buying journey** — the customer states a goal, the AI clarifies, curates *real* products, builds the cart/quote, and completes a *real* checkout. Same engine, any brand, by configuration — not per-customer code.

The mental model: **the LLM is the brain; JourneyAX is the whole body around it** — retrieval, grounding, pricing, cart, payments, multi-tenant isolation, guardrails, UI. A raw LLM is a brain with no hands.

---

## 2. What it offers today (built + working)
**Journey engine**
- Guided journey state flow: *understand intent → clarify (occasion/fit/size, ≤3 Qs) → curate → present → cart/quote → checkout*.
- **Grounding gate** — every recommendation is pinned to the brand's real catalogue + knowledge base; the agent does not invent products, SKUs, prices, or sizes.
- Config-driven per brand: persona/journey-guidance, context dimensions, capabilities, commerce mode.

**Retrieval & knowledge**
- MongoDB Atlas **vector search** over catalogue + knowledge docs (1536-dim embeddings).
- **Knowledge ingestion control plane** — crawl / CSV feed / authored docs (e.g. size charts, fit/care guides) → embedded, per-tenant isolated.

**Commerce backbone (the part chat doesn't have)**
- **Authoritative quote/pricebook engine** — the server sets price/stock/totals; the LLM never does.
- **Order service + real Stripe checkout** (Razorpay-ready).
- **commerceMode**: `quote` (B2B project quote — BOM, finishes) vs `cart` (B2C retail — bag, sizes) — segregated surfaces per brand.

**Surfaces**
- **Storefront** — 40/60 layout (chat + live product/3D panel), themed per brand.
- **Back-office control plane** — onboarding, config tabs, knowledge, rules, publish/rollback with audit.
- **3D configurator** (Three.js) for designable products; 2D personaliser (candy).
- **Embeddable widget** — drop the journey into an external e-commerce site.

**Platform / infra**
- Multi-tenant isolation by `projectId`; **RBAC + JWT auth**, API gateway (single public door), rate limits, secret redaction.
- **Multi-LLM** provider support (OpenAI / Anthropic / Gemini / Ollama), per-project keys.
- **Cloud (GCP)**: Cloud Run scale-to-zero services + Vercel frontends + Atlas + Upstash Redis; gateway with Google IAM service-to-service auth + edge cache; Cloud Build CI/CD (Metafy pattern).

**Verticals proven (same engine)**: Caroma (bathroom fixtures, B2B quote) · Augusta·Momentec (team sportswear + 3D configurator) · M&M'S (personalised candy) · Abercrombie & Fitch (fashion retail, fit/size advisor). 5 customer demos delivered.

---

## 3. What it does NOT offer yet (honest gaps)
- **Self-serve onboarding isn't complete** — hardened retail sites still need an assisted catalogue-acquisition step (URL → live isn't zero-touch for bot-walled SPAs).
- **Data-quality bound** — thin/incomplete brand catalogues (missing accessories, structured attributes, colour codes, per-garment measurements) cap some use cases.
- **No live inventory/stock sync** to source systems in standalone mode; Shopify/commercetools **integration connectors only partially wired**.
- **No relevance floor in retrieval** yet → can over-promise on out-of-catalogue asks.
- **No loyalty/membership, returns, or order-tracking** flows; no guaranteed per-SKU fit (needs measurement feeds).
- **Resilience/ops gaps**: multi-provider LLM fallback not fully wired (OpenAI rate limits bite); observability/analytics surface is minimal; test coverage thin; no service mesh / multi-region yet.
- Web/embed only — **no native mobile app**.

---

## 4. Why not just ChatGPT / Claude? (the differentiation — articulate it THIS way)
**Do NOT lead with "grounded / no hallucination."** Once ChatGPT plugs into a brand's live data (connectors/RAG), that's **table stakes**, not a moat. The durable, business-understandable answer is about **who owns the channel and the customer.**

**The one question a brand actually faces:** *Do you want to sell THROUGH OpenAI's assistant, or have YOUR OWN AI salesperson on YOUR OWN site?*

- **ChatGPT + your data = you're a supplier inside OpenAI's channel.** OpenAI owns the customer, the conversation, the data, and the ranking. Your product sits next to competitors; the "neutral" assistant compares you and often picks the cheapest. OpenAI sets the rules, takes a cut, and can change the game overnight. You're **renting shelf space in someone else's store.**
- **JourneyAX = your own AI commerce channel, on your own surface.** Runs on the brand's site/app/domain — customer, data, relationship stay the brand's. The agent works **for the brand** (its bundles, margin logic, brand voice, compliance rules — not a neutral shopper's agent). The brand controls the experience AND the economics. Nobody disintermediates it.

**The line that lands:** **ChatGPT is Amazon. JourneyAX is Shopify.** Selling on a marketplace is fine for reach, but no serious brand lets it own its customer and brand — that's why every brand also runs its own store. JourneyAX is that store for the AI era.

**"Why not build it in ChatGPT?"** Because you're not building a chatbot — you're building your commerce **channel**. ChatGPT can't *be* your channel; it *is* OpenAI's. JourneyAX makes the channel yours (multi-tenant, your site, your data, your rules); the LLM (Claude/GPT/Gemini) is the **swappable engine inside it.**

Secondary (the *how*, not the *why* — mention after the ownership point, don't lead): it transacts (real quote/cart/Stripe, not chat) · deterministic where it must be (price/stock/rules = server logic, not LLM guesses) · a platform not a prompt (new brand = config) · provider-agnostic.

**Business it unlocks:** own the customer + data + margin; conversion↑ (guided vs 847 results), AOV/UPT↑ (full looks), returns↓ (fit advisor), support-cost↓; near-zero marginal cost to onboard the next brand (config, not code).

---

## 5. Roadmap (technical)
**Now (0–2 wks):** cloud hardening (gateway single-door ✓, private services, edge cache) · onboarding + ingestion automation · A&F Denim Finder + Fit Advisor · journey guardrails (post-clarify deferral fixed, add retrieval relevance floor).

**Next (4–6 wks):** per-tenant LLM keys + **multi-provider fallback** (rate-limit resilience) · Redis-backed gateway edge cache live · more journeys (complete-the-look, trip/packing, gift) · operator **analytics surface** · real Shopify/commercetools **integration connectors**.

**Later (quarter+):** self-serve **URL→live** onboarding · **service mesh** (mTLS east/west) · multi-region scale + enterprise (SSO, SLA, audit) · inventory/stock sync · loyalty + returns + order-tracking · per-garment measurements for guaranteed fit.
