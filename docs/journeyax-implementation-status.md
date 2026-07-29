# JourneyAX — Implementation Status (current-state map)

_A running record of what has been built, what is verified, and what remains.
Companion to `journeyax-conversational-agent-requirements-and-implementation-plan.md`._

---

## 1. Architecture principles now enforced in code

1. **Per-project config lives in the DB, edited in the back office.** Only platform
   deployment values (API keys, service URLs, JWT secret, a fast internal
   `INTENT_MODEL`) stay in ENV. Model, persona, journey guidance, business rules,
   channel/connector credentials, and **enabled capabilities** are all per-project
   config in `journeyax.tenant_configs`.
2. **`projectId` in the URL, validated at the gateway.** Tenant-scoped routes are
   `/api/v1/:projectId/<domain>/…`; the gateway authenticates the JWT and rejects
   any path projectId the identity isn't entitled to (cross-tenant → 403).
3. **The journey is emergent, not scripted.** No forced-phase / keyword heuristics.
   The model reasons each turn, guided by per-project journey guidance + business
   rules. Integrity is guaranteed by *outcome* enforcement (panel must render), not
   *flow* hardcoding.
4. **The toolset is dynamic.** The agent assembles its tools per turn from
   `project.capabilities` — a products / services / program business each gets a
   different toolset from the same generic core, no code change.

---

## 2. What is built and verified

### Platform / multi-tenant
- **Auth** (`auth-service`, :8080) — real JWT login; console gated; `admin`/`admin`
  seeded (`seed-admin.ts`). Sign-out revokes the refresh token.
- **Onboarding + tenant switcher** — Onboard-Customer wizard creates org
  (`organization-service` :8085) + project (`project-service` :8082) + links them;
  console switches between live projects.
- **Gateway tenant isolation** (`api-gateway` :3010) — `/api/v1/:projectId/<domain>`
  scheme; `auth.guard` validates projectId vs JWT; verified cross-tenant request →
  **403**, same-tenant → 200. Live path (commerce + product) converted; stub
  services (analytics/leads/data) still on old patterns.

### Back-office console (`backoffice-admin` :3009)
- **B1 — config-driven shell (done, verified):** nav sections + labels resolve from the
  active project (`lib/console-sections.ts` catalog + `resolveConsoleSections`; per-project
  `project.console.{labels,hidden,order}`). Verified in browser: Caroma default nav vs
  Abercrombie "Styling Journeys / Collection / Product Knowledge" with Platform&Ops hidden.
  Workwear sign-in/dashboard copy de-hardcoded; unwired tabs badged **DEMO** (nav pill +
  `DemoNotice` banner); fake channels grid + orphan single-tenant `/rules` route removed.
- **B2 — versioned publish lifecycle (done, verified):** the project doc is the mutable
  DRAFT; `POST :id/publish` snapshots it into immutable `config_versions` (+`activeVersion`
  pointer, note, publishedBy); `GET :id/published` is what the RUNTIME consumes (agent
  config-loader + storefront /api/config switched; falls back to draft pre-first-publish);
  `GET :id/versions` = audit; `POST :id/rollback/:v` re-points. Console header shows a
  per-project **v-badge (draft/live/unpublished-changes) + Publish + version history with
  one-click rollback** (`PublishControl.tsx`). **Verified E2E:** draft edit did NOT reach
  /published; publish flipped it; rollback reverted; agent trace shows `configV=N` per turn.
- Real logo; single top-bar login; tenant switcher with per-project brand colour.
- **AI Orchestration tab** — per-project **model** (OpenAI incl. gpt-5.5 / gpt-5,
  Anthropic, Ollama), temperature, embedding model, agent name, **system prompt
  overrides**, **journey guidance**, and **capability toggles**.
- **Business Rules tab** — condition→action rules (folded in from the standalone
  page), tenant-scoped.
- **Knowledge Base tab** — real corpus stats + dedup, per brand.
- **Channels tab** — per-project WhatsApp Cloud API credentials (phone number id,
  token) stored on the project; webhook resolves tenant by phone number id.

### Console fully live — no demo screens left (B5)
- **Every one of the 14 console sections is now wired to real data** (all DEMO badges
  removed). New server routes: `/api/insights` (aggregates the agent's own
  `journeyx.sessions` — KPIs, stage funnel, intents, recent sessions, quote/BOM
  sessions), `/api/platform/health` (live pings to all 7 services), `/api/users`
  (auth-service accounts per tenant), `/api/catalogue` (per-project product corpus,
  deduped by page, best-title selection).
- **Live components:** DashboardLive (real KPIs + funnel + recent sessions),
  AnalyticsLive (funnel with drop-offs + intent distribution), OrdersQuotes (real
  quote/BOM sessions from journey state), CatalogueView (searchable 2,265-product
  table), JourneyMap (Journey Builder = live view of the project's configured journey
  with edit link), PlatformOps (real health, 15s refresh), UsersRoles (real accounts),
  NotificationsConfig (per-project prefs persisted to `project.notifications`),
  AccountView (real signed-in user + org + workspace facts).
- **page.tsx shrank ~2,000 → ~500 lines** — all Workwear/Caroma mock markup, fake
  charts, mock leads and the demo chat deleted.
- **UI template hardened** (user feedback): global border-box reset; canonical
  `.form-grid`/`.flabel`/`.field`/`.fhelp` primitives; responsive breakpoints; all
  config components refactored onto the template (no inline form-style re-invention).
- Verified in browser tab-by-tab with real data (153 sessions, funnel 153→73→50→16→6,
  3,770 docs, real users, real quote, all-services-healthy); notification prefs
  round-trip confirmed in the DB. All projects republished (caroma v4, abercrombie v4,
  dorf-trade v2, caroma-nz v2).

### Agent Embed — drop-in widget for actual e-commerce sites
- **One-line install:** `<script src="<storefront>/embed.js" data-project="…" …>` injects a
  floating launcher + iframe of the AX surface in **embed mode** (`?project=<id>&embed=1`,
  compact single-column, hero hidden). Loader derives origin from its own script src
  (proxy-safe) with a `data-origin` override; posts `jax:close` support.
- **Back-office "Agent Embed" section** (`AgentEmbed.tsx`, new console section): launcher
  label/corner/accent/allowed-origins config (`project.embed`), the copy-paste snippet,
  and a **live preview** of the real embedded agent.
- **Verified end-to-end:** embedded the Caroma agent on an EXTERNAL fake e-commerce site
  ("Northlake Home", separate origin :4700) — launcher rendered, panel opened, the full
  Caroma AX agent ran inside it (header/persona/greeting/pills/input). Storefront has no
  X-Frame-Options so it iframes anywhere.
- Also removed the last storefront hardcode ("Consumer · Bathroom" header chip → labels-driven).

### Multi-storefront routing (one storefront, every project)
- **Tenant resolved PER REQUEST** (`journeyax-web/src/lib/tenant.ts`): `?project=` param
  → `X-Tenant-ID` header → **Host domain** (via new project-service
  `GET /resolve/domain/:domain`, 60s cache) → env fallback. Wired through
  `/api/config`, `/api/chat`, `/api/chat/stream`.
- **Client pins every chat to the resolved tenant** (X-Tenant-ID from config context via
  a live ref — fixed a stale-closure bug where send handlers held the default tenant);
  chat session ids namespaced per tenant in localStorage (no cross-tenant resume).
- **Remaining storefront hardcodes removed:** hero, greeting (now `persona.greetingMessage`
  per project — Caroma's old showroom greeting moved INTO its config), suggestion pills
  (labels-driven), product-card source link (hostname from product URL).
- **Verified end-to-end:** `localhost:3008/?project=papertrail` renders Paper Trail
  branding + bookseller greeting; a "dark mystery" chat routed to the papertrail agent
  and returned REAL books (Sharp Objects et al.) with "Books matched to your brief"
  cards + quote CTA. Host-header routing verified (`Host: papertrailbooks.example` →
  papertrail). Default (no param/domain) stays caroma.

### Drill-downs + rules editing (user-feedback round after B5)
- **Catalogue → product detail drawer:** click any row → full detail merged across the
  product's chunks (`/api/catalogue/item`): photo(s), SKU/price/category pills,
  description, complete spec table, variants, linked technical PDFs, source link, and
  the RAW grounding chunks ("what the agent reads") — proving the data is real, not
  display copy.
- **Business Rules → full CRUD:** edit-in-place added (was add/toggle/delete only),
  labelled form, delete confirmation, and a **"Behind the scenes"** panel showing the
  exact `[BUSINESS RULES …]` block injected into the agent each turn.
- **Orders & Quotes → expandable rows:** click a quote → every BOM line (name, SKU,
  category, qty, price). Insights route now returns full `lines`.
- All verified in browser.

### Integrations / platform switching (B3)
- **Adapter registry is config-driven (done, verified):** `AdapterRegistry` getters are
  async and resolve each tenant's platform **+ connection credentials** from the
  PUBLISHED project config (`integrations.platforms` + per-platform connection) via
  `createPublishedConfigResolver` (60s cache, standalone fallback). Installed at agent
  bootstrap. **Verified:** caroma → standalone (real results); abercrombie →
  `commercetools` adapter purely by config, no code change.
- **CommercetoolsKnowledgeAdapter (new):** OAuth2 client-credentials (token cache) +
  `product-projections/search` with configurable `searchLocale`; maps to the SAME
  grounding envelope as standalone (found/results/content/specs/imageUrl); honest
  "connection not configured" message when creds are missing. Credentials live in
  `project.integrations.commercetools` (back office → DB), never env.
- **Integrations tab is REAL (replaces the fake "Connected" board):**
  `IntegrationsConfig.tsx` — per-domain platform selector (knowledge/commerce),
  commercetools credential form, **Test connection** (live OAuth + product query via
  `/api/integrations/test-commercetools`). Saved to draft; Publish switches runtime.
- **LLM provider registry (`llm/provider.ts`):** the agent now branches on
  `ai.provider` — openai (default) / anthropic (OpenAI-compat endpoint,
  `ANTHROPIC_API_KEY`) / ollama (`OLLAMA_BASE_URL`), with warn+fallback to OpenAI when
  a key is missing. All generation calls (buffered/streaming/forceUiTool) use the
  per-project client; intent stays on the fast platform model.
- _Open:_ live CT verification needs a real Merchant Center API client (creds entered
  in the Integrations tab); Anthropic/Ollama live runs need their platform env keys.

### Knowledge ingestion control plane (B4)
- **Self-serve, per-project ingestion (done, verified E2E):** `project.knowledgeSource`
  (domain/seedUrls/sitemapUrl/maxPages — edited in the Knowledge tab) drives a GENERIC
  runner `scripts/ingest-project.ts` (Playwright crawl → heuristic classify → chunk →
  embed → upsert). No more Caroma-hardcoded scripts for onboarding.
- **Job control:** `POST /api/knowledge/ingest` creates an `ingest_jobs` doc and spawns
  the runner detached (one run per project at a time); `GET ?jobId=` for status. The
  Knowledge tab has **Save source / Test ingest (5) / Start ingest** + live
  progress/log polling.
- **Isolation contract FIXED:** documents now carry `projectId` (upsert key includes it);
  all 3,770 legacy caroma docs backfilled with `projectId="caroma"`; stats filter keys on
  projectId first. **Verified:** caroma-nz configured via API → ingest job completed
  3/3 pages, docs tagged `projectId="caroma-nz"`, caroma corpus untouched, per-project
  stats correct, job status/log visible in the console UI.
- _Note:_ v1 runner is generic text ingestion; the rich Caroma extractor (specs/PDF
  parsing) remains available for deep product corpora — can become a per-source "profile"
  later.

### Knowledge / RAG
- Full Playwright scrape complete: **2,265 products (99% with specs)**, 155 designs,
  1,194 technical + 48 troubleshooting PDF chunks, deduped to 0 duplicate groups.
- Atlas Vector Search index `vector_index` (1536-dim, cosine) live; ~71 ms semantic
  queries. product-service uses `metadata.images` (real PIM photos) + `metadata.specs`
  + `description` (fixed — was regex-scraping `cdn.` banners).
- Retrieval type is intent-driven (design/collection for remodel, troubleshooting
  for leak, product for selection) via a prescriptive `retrieval-router`.

### Agent (`agent-commerce-service` :3004)
- **Phase G — context dimensions engine (generic, replaces the fixed space classifier):**
  projects configure their own `contextDimensions` (Caroma: `space`+`projectType`;
  Fashion: `occasion`/`fit`/`style`; Workwear: `industry`/`role`/`climate`). The intent
  resolver extracts values against that per-project schema; the retrieval router scopes
  searches by the dimensions marked `filtersRetrieval`; `scoping` dimensions gate
  in/out-of-scope. Back-compat: a project with only `scope.rooms` auto-synthesises a
  `space` dimension (Caroma unchanged). Extracting a dimension no longer implies
  discovery is done (kept clarify-first). **Editable in the back office** (AI
  Orchestration → Context dimensions: add/remove, key/label/values/scoping/filters) —
  verified save persists to the DB. **Verified multi-vertical:** eval `dim-caroma-multi`
  (space=Kitchen, projectType=renovation) and `dim-fashion-occasion` on the `abercrombie`
  project (occasion=party, fit=relaxed, style=smart casual) both green — SAME code, 10/10
  fast suite passing across two verticals. _Open refinement:_ cross-domain `inScope`
  gating (a bathroom request to a fashion store) still leans on the business-scope block +
  empty-retrieval rather than a hard dimension gate.
- **Phase F — generic platform prompt (journey is DATA, not code):** `base.ts` was a
  hardcoded Caroma four-phase bathroom journey; it is now a domain-NEUTRAL platform
  contract (grounding, use-the-panel, clarify-when-context-missing, follow-config,
  safety) with NO business identity, vocabulary, or fixed phase order. `stage.ts` hints
  de-domained (items/guide/quote, not bathroom/toilet/finish). The Caroma journey moved
  into `persona.journeyGuidance` (DB config). **Verified two ways:** (1) 10/10 evals stay
  green — Caroma's clarify→products(real sku/price)→install journey preserved, now driven
  by config; (2) the SAME code on the `abercrombie` (fashion) project produced a coherent
  smart-casual-outfit reply with zero bathroom leakage. _Exposed next gap:_ the `space`
  dimension is still Caroma-shaped (`scope.rooms`); a fashion/workwear tenant needs
  **project-configured context dimensions** (occasion/fit, industry/role) not fixed rooms
  — this is the next slice (matches the capability-architecture critique step 6).
- **Phase A — un-hardcoded / config-driven:** removed `routePostClarify` +
  `mustForceClarify`; per-project model wired everywhere (`ProjectAiConfig.model`,
  reasoning-model temperature auto-gated); journey guidance injected from config;
  intent resolver made **generic + conversation-aware** (advances out of discovery
  from flow, not a keyword). Verified: clarify still renders, post-clarify advances
  to products with real data.
- **Phase B — capabilities:** generic tools `showAccessories`, `presentChoice`
  (DIY/plumber), `showInstallGuide` (attaches real PDFs), `showWarranty`; storefront
  panels + reducer actions + `__journeySend` bridge. Verified: model calls
  `showInstallGuide` with real PDF URLs + `presentChoice` on its own.
- **C1 — dynamic toolset + config UI:** `buildToolset(project.capabilities)` replaces
  the hardcoded array; `capabilities` field + back-office toggles. Verified:
  disabling `installGuide` removed the tool at runtime.
- **C2:** business-specific strings removed from tool descriptions; **primitives
  renamed to domain-neutral** — `showProducts→showItems`, `showAccessories→showAddons`,
  `showInstallGuide→showDocuments`, `showWarranty→showInfo` (agent + storefront
  handlers, coordinated; capability ids unchanged so no DB migration). Verified:
  `showItems` fires with real data, journey intact. _Remaining: per-project display
  labels ("Products" vs "Services") + optionally renaming panel files — pairs with
  Phase 4 storefront-reads-project-config._
- **Latency:** search execution parallelized; intent uses a fast model.
- **Panel-render enforcement** (`forceUiTool`): if retrieval happened but the panel
  tool didn't fire, it's forced once — integrity, not flow.

### Storefront (`journeyax-web` :3008) — the 40/60 journey window
- Verified end-to-end: intent → clarify (dynamic questions) → products (real PIM
  images + specs) → **quote** (BOM, discount, tax, warranties, checkout CTA).
- Fixed: `413 request entity too large` on the quote turn (agent body limit → 10 MB);
  resilient SSE stream; 4 s keepalive heartbeat.
- **WhatsApp (Tier-1) webhook** — verify handshake + inbound → agent → reply; routes
  by phone number id to the owning tenant (multi-tenant, no shared env secrets).

---

## 3. Config: where each thing lives

| Concern | Home |
|---|---|
| Model / temperature / embedding | `project.ai` (DB, back office) |
| Persona / system prompt / **journey guidance** | `project.persona` (DB, back office) |
| **Enabled capabilities (toolset)** | `project.capabilities` (DB, back office) |
| Business rules | `project` rules (DB, back office) |
| Channel/connector credentials | `project.integrations` (DB, back office) |
| Theme (storefront) | `project.theme` (DB, back office) |
| API keys, service URLs, JWT secret, INTENT_MODEL | ENV (platform deployment only) |

---

### Phase 4 — storefront reads project config (theme + labels)
- Storefront `/api/config` fetches the project's public config; `StorefrontConfigProvider`
  applies **theme** to CSS variables at runtime and provides **labels** + brand.
- Header (company name, title, persona), accent colour, and panel labels
  ("Products" → configurable) are now per-project config, not hardcoded.
- **Verified dynamic:** flipping Caroma's config re-themed the storefront gold→blue and
  relabelled "Bathroom Configurator" → "Services Configurator" on reload — no code change.
  This also completes the **C2 label tail**.

## 4. Remaining work

- **C2 (optional polish):** the `searchKnowledge` type-enum *examples* are still
  bathroom-flavoured (illustrative, don't break other verticals); renaming panel
  *files* (`ProductsPanel→ItemsPanel`) is cosmetic. Move enum examples to config if
  a very different vertical is onboarded.
- **Phase D (done):** generic space classification driven by `project.scope.rooms`.
  The intent resolver classifies each turn into one of the business's *configured*
  spaces (or `out_of_scope`), and the retrieval router scopes searches to that space.
  `IntentResult.space` + `LoadedProjectConfig.scope` carry it; the served-spaces list
  is injected into the agent's context so it stays in scope. **Verified config-driven:**
  toggling `Kitchen` in `scope.rooms` in the DB flips the same "kitchen sink" turn
  between `space=out_of_scope` and `space=Kitchen` with no code change — the design's
  core proof. Caroma's real catalogue spans **Bathroom / Ensuite / Powder Room /
  Kitchen (sinks, tapware) / Laundry (tubs)**, so `Kitchen` is now permanently in
  scope (the seed config had wrongly omitted it — a data fix, not code). A kitchen-sink
  brief returns real Caroma sinks (Monaco/Arctic/Vital double-bowl undermount, real
  SKUs + prices). Eval scenarios `space-laundry`, `space-kitchen`, `space-out-of-scope`
  green.
- **Phase E (started):** evaluation harness exists — `apps/agent-commerce-service/src/eval/run-evals.ts`
  streams scenarios against the live agent and asserts intent, journey progression,
  which capabilities fire, grounding (real sku/price), and safety (out-of-scope,
  prompt injection). 10 representative scenarios green today (incl. Phase D space
  classification for laundry/kitchen/out-of-scope); **expand toward 20–30 +
  wire into CI** (categories: comparison, follow-up reference, conflicting reqs,
  cross-project 403, locale, duplicate turns). Run: `npx tsx …/run-evals.ts`
  (`EVAL_FAST=1` for single-turn only, `EVAL_FILTER=<name>`).
- **Latency:** optional mixed-tier (fast orchestration model + reasoning model for
  synthesis) to cut the ~45 s reasoning-model product turn.
- **Second pass of projectId-in-URL** over stub services (analytics / leads / data).
- **Back-office Capabilities → per-project labels** once C2 lands.

---

## 5. Key facts

- **Databases:** `journeyx` = auth users + scraped knowledge (`documents`);
  `journeyax` = `tenant_configs` (projects) + organizations.
- **Ports:** gateway 3010 · agent 3004 · product 8083 · project 8082 · org 8085 ·
  auth 8080 · data 8084 · storefront 3008 · back office 3009.
- **Caroma project config:** model `gpt-5.5`, journey guidance set, all 7 capabilities
  enabled; `scope.rooms` = Bathroom / Ensuite / Powder Room / Kitchen / Laundry
  (kitchen sinks + tapware and laundry tubs are real Caroma verticals, scraped).
- **Known constraints in Caroma data:** no per-product inventory, no customer reviews,
  no per-product warranty (warranty is on the general policy page) — the agent is
  instructed to say so honestly rather than invent.
