# Back-office audit — what's real vs. mockup, per-project vs. hardcoded

_Audit date: 2026-07-14. Method: inspected the running console (localhost:3009, logged in as admin)
and the source (`apps/backoffice-admin`), plus the live DB and services. Every claim below is
verified against code (`file:line`) or data._

## Verdict in one line

Of **13 nav items, only 3½ are genuinely real, editable and per-project** (AI Orchestration,
Business Rules, Channels-partial, Knowledge Base read-only). The rest are **static Workwear/Caroma
demo markup** — not wired to any service, not editable, and identical for every project. The nav
labels and section set are themselves hardcoded (Workwear-flavoured) rather than per-project.

## Per-tab findings

Legend: 🟢 real+editable+per-project · 🟡 partial · 🔴 static mock (not wired, not editable, not per-project)

| Nav item | State | Editable? | Per-project? | Wired to | Gap / what's needed |
|---|---|---|---|---|---|
| **Dashboard** | 🔴 | no | no | nothing (hardcoded KPIs, leads, charts, chat sim) | Real per-project metrics from analytics/agent-service; drop the mock Workwear leads |
| **Journey Builder** | 🔴 | no | no | nothing | Should edit the project's journey/capabilities/dimensions (overlaps AI Orchestration) — decide its role or remove |
| **Catalogue & Compliance** | 🔴 | local toggles only (discountTier/freightZone/margin — not persisted) | no | nothing | Bind to product-service catalogue + project pricing/compliance config |
| **Rosters & Orders** | 🔴 | no | no | nothing | Bind to order-service (or remove for non-program verticals) |
| **Analytics** | 🔴 | no | no | nothing (static funnel/bar SVGs) | Real funnel from agent-service sessions |
| **Channels** | 🟡 | WhatsApp yes | WhatsApp yes | `ChannelsConfig` → project.integrations.whatsapp (persists) | The "ALL CHANNELS" grid below it is static local-state toggles with `workwearGroup.com.au` hardcoded |
| **Integrations & Adapters** | 🔴 | no | no | nothing — "Commercetools/SAP/Salesforce **Connected**" pills are decorative | `project.integrations` (shopify/commercetools/woocommerce) **exists in schema** but is NOT surfaced or editable here |
| **AI Orchestration** | 🟢 | yes | yes | `AiOrchestration` → project.ai/persona/capabilities/contextDimensions | Solid. (Static "pipeline architecture" reference cards below are cosmetic.) Provider still OpenAI-only at runtime |
| **Business Rules** | 🟢 | yes (CRUD) | yes | `BusinessRules` → project rules API | Solid |
| **Knowledge Base** | 🟡 | read-only + dedup | yes | `/api/knowledge/stats` + `/dedup` | **No scrape/ingest trigger** — says "run the scrape" but has no button. Data is single-brand (below) |
| **Platform & Ops** | 🔴 | no | n/a (platform) | nothing — all "Healthy" pills are static | Real health from service `/health` endpoints |
| **Users & Roles** | 🔴 | no | no | nothing (static rows) | Bind to auth-service users, scoped by project |
| **Notifications** | 🔴 | local toggles (not persisted) | no | nothing | Persist per-project notification prefs |
| **Account** | 🔴 | no | no | nothing | Real user profile from auth-service |

## Cross-cutting issues (bigger than any one tab)

### A. The shell itself is hardcoded, not per-project
Nav labels + section set are fixed Workwear terms — **"Catalogue & Compliance", "Rosters & Orders",
"Journey Builder"** (`app/page.tsx:668,675`). For a fashion retailer (Abercrombie) these are wrong;
for a services/booking business they're nonsense. Sign-in copy is `"The right gear, every worker,
every time."` (`page.tsx:543`); the dashboard says `"across all Workwear Group channels"`
(`page.tsx:843`) regardless of which project is active. **The nav, labels and which sections exist
should be driven by the project's type/capabilities**, the same way the storefront now is.

### B. Knowledge is single-brand — that's why dorf-trade / abercrombie "show nothing"
All **3,770** docs in `journeyx.documents` are `metadata.brand: "caroma"`; `distinct(metadata.brand)
= ["caroma"]`. abercrombie, dorf-trade, caroma-nz have **0 docs**. Any data-backed tab (Knowledge,
and a real Dashboard/Analytics) is therefore empty for every project except Caroma. Also note docs
are isolated by a `metadata.brand` string derived from `projectId`, **not** by `projectId` itself —
that isolation key should be unified.

### C. There is no way to start a scrape from the console
Ingestion is a set of **CLI scripts run by hand** — `apps/journeyax-web/src/scripts/scrape-products.ts`,
`ingest-master.ts`, `ingest-from-sitemap.ts`, `services/knowledge/crawler.ts`. The only knowledge
HTTP endpoints are **stats** and **dedup** (read + cleanup). To onboard Abercrombie you currently
have to run scripts manually with the right env. **Needed:** a per-project "Configure source +
Start ingest" action → a background job (worker/queue) → live status/progress back in the Knowledge
tab. This is the single biggest blocker to onboarding a new brand self-serve.

### D. Integrations is a fake status board
The four "Connected" cards (`page.tsx:1670-1694`) are static. The real, editable connector config
(`project.integrations.{shopify,commercetools,woocommerce}`) — which the schema and agent already
support — is not exposed anywhere in the UI. "If I want to change it, I can't" is correct.

### E. Provider selection is cosmetic at runtime
AI Orchestration lets you pick Anthropic/Ollama, but the agent instantiates only an OpenAI client,
so a non-OpenAI choice would be sent to OpenAI. Needs a provider registry (tracked separately).

## What "everything configurable per project" actually requires

1. **Config-driven shell** — nav sections, labels, and copy resolved from the project (type +
   capabilities + labels), not hardcoded. Reuse the storefront's config pattern.
2. **Ingestion control plane** — source config + "Start ingest" + job status, per project; unify the
   knowledge isolation key on `projectId`.
3. **Integrations editor** — surface `project.integrations` as real, editable, per-project connector
   forms (replace the fake status board).
4. **Wire or retire the mock tabs** — Dashboard/Analytics/Catalogue/Orders/Users/Notifications either
   bind to real services (per-project) or are hidden for verticals that don't use them.
5. **Provider registry** — make Anthropic/Ollama selection real.

## Bottom line for the two sample projects
- **Caroma** looks complete only because it's the one brand with scraped data + tuned config.
- **Abercrombie / dorf-trade** expose the truth: no knowledge, Workwear-labelled nav, fake
  integrations, no scrape button — i.e. the console is **not yet a multi-tenant control plane**, it's
  a Caroma/Workwear demo shell with 3½ genuinely dynamic tabs bolted in.
