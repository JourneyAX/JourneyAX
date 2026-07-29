# JourneyAX Architecture — alignment review

Reference: the "JourneyAX Architecture" board (Experience Channels → Agent Layer → AI Orchestration
→ Integration Layer/API Gateway → Domain Systems A–D with Adapter Layers → Shared Platform Services
+ Data Stores). This is the FOUNDATION; everything below is measured against it.

---

## 1. Already aligned ✅

| Architecture block | Implementation |
|---|---|
| **Integration Layer (API Gateway)** | `apps/api-gateway` — auth & authz (RBAC + permissions), request validation, rate limiting (ChatThrottleGuard), error handling, logging |
| **Adapter Layers (A–D)** | `packages/integration` — **ports & adapters done properly**: `CommercePort`, `KnowledgePort`, `CrmPort`, `FulfilmentPort`, `ConfiguratorPort` + Shopify / CommerceTools / Salesforce / standalone adapters, resolved per tenant by `AdapterRegistry` |
| **Agent Layer** | NLU, intent detection, context & memory (journey-memory + session store), dialog mgmt, tool/action selection, response generation, guardrails |
| **AI Orchestration & Tool Routing** | intent→domain mapping, agent orchestrator, tool router, capability→tool registry, session/personalisation state |
| **Auth & SSO / Config & Secrets** | auth-service (JWT+refresh), HttpOnly-cookie BFF, per-project config with secret redaction, config versioning & publish |
| **Data Stores** | Operational DB (`products`, `orders`, `quotes`, `sessions`), **Vector DB** (Atlas `$vectorSearch` on `documents`) |
| **Knowledge & Content** | RAG corpus, product catalogue & specs, installation/decoration PDFs, policies/FAQs, pricing rules |

**Interface-driven and adapter-based is already the house style** — `ports.ts` + `AdapterRegistry` is
textbook hexagonal architecture. The problem is that my *new ingestion code didn't follow it.*

---

## 2. Where my ingestion code VIOLATES the architecture ❌

Honest assessment of what I built in the last pass:

| Violation | Where | Should be |
|---|---|---|
| **No Converter/Populator layer** — all field mapping is one procedural `foldRow()` | `csv-feed.ts:106` | `Converter<SOURCE,TARGET>` orchestrating ordered, single-responsibility `Populator<S,T>`s (Identity, Price, Colour, Image, Variant, Stock) |
| **`switch` on source type instead of an interface** | `pipeline.ts:57/284/340` (`s.type === 'csv-feed'` …) | `IngestionSourcePort` implementations registered in a `SourceConnectorRegistry` — same pattern as `AdapterRegistry` |
| **Ingestion lives inside an app, not a shared package** | `apps/journeyax-web/src/services/knowledge/*` | `packages/ingestion` so any service can consume it |
| **No facade** | pipeline called directly | `KnowledgeFacade` / `CatalogueFacade` returning DTOs, orchestrating services |
| **Object Storage** | local `data/` (2.6 GB) | Object Storage block in the diagram → per-project GCS bucket (AUG-8) |
| **Message Broker** | detached `spawn()` per job | Kafka/RabbitMQ block → enqueue ingest jobs, retries + DLQ |

**Bidirectional conversion (your source↔target point)** is genuinely missing: today mapping is
one-way (feed → canonical). We need `Converter` pairs so canonical → external DTO also works — that's
what makes write-back (order push, inventory sync, PIM export) possible later.

---

## 3. Missing from the platform vs the diagram

- **Caching (Redis)** — rate limiter is per-node in-memory; sessions/catalogue uncached
- **Analytics / Warehouse**, **Feature Flags** — not built
- **Human Handoff & Guardrails** — guardrails partial, handoff absent
- **Channels**: Voice/IVR, Email, In-Store/Kiosk, Partner/Dealer Portal, Sales/CSR Console — only Web + WhatsApp exist
- **Visual Planner & Image Gen** — only the 3D configurator
- **Recommendation Engine** — implicit in the agent, not a discrete service

---

## 4. What I'd ADD to the architecture (you asked what's missing)

1. **Data Ingestion & Enrichment as a first-class layer.** The board treats "Knowledge & Content" as an
   optional passive box, but it's now a real pipeline: *Source Connectors → Converters/Populators →
   Entity Resolution → Enrichment (narratives) → Dual Indexing (vector + structured)*. It deserves its
   own lane beside the Adapter Layers.
2. **Master Data & Entity Resolution.** The `Parent_SKU` join, adult/youth/ladies sizing triplets, and
   collection membership are MDM concerns. We hit this for real — without it the catalogue fragments.
3. **Data Quality & Reconciliation.** Coverage metrics, orphan detection, drift alerts. We silently
   lost 378 products until it was caught; that must be a system property, not luck.
4. **Skills Registry** (your own idea) — in the Agent Layer, distinct from tools/capabilities:
   `{instructions + retrieval scope + tools + examples + guardrails}`, versioned, per project.
5. **Model Router & Cost Governance** — multi-LLM provider registry exists, but routing policy
   (cheap model for bulk, frontier for conversation) and budget caps are not modelled.
6. **Evaluation & Guardrail Harness** — offline eval suite + online guardrail telemetry.
7. **Consent, PII & Data Residency** — multi-country (US/CA/MX) makes this concrete, not theoretical.
8. **Config Versioning & Publish Lifecycle** — already built (draft→publish→rollback); belongs on the
   board under Shared Platform Services since every tenant change flows through it.

---

## 5. Refactor plan (bringing ingestion back onto the architecture)

`packages/ingestion`
```
ports.ts                 IngestionSourcePort, Converter<S,T>, Populator<S,T>, IngestionContext
registry.ts              SourceConnectorRegistry (mirrors AdapterRegistry)
converters/              CsvRowToProductConverter, ProductToDocumentConverter, (reverse converters)
populators/              identity, price, colour, image, variant, stock, decoration, fabric
connectors/              csv-feed, pdf, kb-articles, websphere-rest, html
facade.ts                KnowledgeFacade — the single entry the services call
```
Rules: connectors know only their source; populators are single-responsibility and ordered;
converters compose populators; the pipeline depends on the **port**, never a concrete connector.
Adding a new tenant = configuration. Adding a new source type = one connector registration.

---

## Integration Layer — added box: BUSINESS (2026-07-18)

The board's Integration Layer had Commerce, Project Config, Order Fulfilment and
Customer CRM/Support. A sixth box is now implemented: **Business**.

**Why it was missing.** Every other port answers *"how do I do X"* — search, price,
fulfil, ticket. None answered *"what KIND of business am I serving, and what is my
customer actually buying for?"* Without it, vertical assumptions leak into the agent
as code. The tell was `findTeam`: a teamwear-specific tool sitting in a supposedly
generic agent. Augusta's customer buys for a **team**; Caroma's buys for a **room**;
a workwear tenant's for a **site crew**. Same capability, three hardcoded shapes.

**The abstraction: `BusinessEntityModel`.** Every business's customer buys ON BEHALF
OF something. Modelling that once turns "find the team" and "find the site" into one
capability with configured vocabulary.

    packages/integration/src/business.types.ts   BusinessProfile, BusinessEntityModel, BusinessEntity
    packages/integration/src/ports.ts            BusinessPort (getProfile / findEntities / registerEntity)
    .../adapters/business/config.business.adapter.ts   ConfigBusinessAdapter (the default)
    apps/project-service .. ProjectBusiness       the per-tenant config that drives it

**Deliberately ONE adapter, not one per vertical.** `ConfigBusinessAdapter` derives the
whole profile from (a) the tenant's project config and (b) its ingested catalogue —
so onboarding a teamwear brand, a bathroom brand and a workwear brand is a CONFIG
change, not a code change. A vertical earns its own adapter only if it has logic no
config can express; none does yet.

**Consumption.** `ConfigLoader.loadBrandHub` now calls `adapterRegistry.getBusiness()`
instead of fetching product-service by URL. The agent depends on the port, not a service.

**Provenance is carried, not assumed.** `confirmWithCustomer` (team colours, logo
artwork) is config, so the "never assert, always confirm" rule travels with the
business definition instead of living in a tool description.

### Closed by AUG-17 / AUG-18
- **Back-office editor** — `components/BusinessProfileConfig.tsx`, a "Business Profile"
  section under Platform. An operator now defines the business model, buyers, and the
  entity its customers buy for, plus the attributes that must be confirmed rather than
  asserted.
- **Generic entity tools** — `findTeam`/`registerTeam` are now `findEntity`/`registerEntity`,
  routed through the **BusinessPort** (not KnowledgePort — entity identity is a business
  concern). `buildToolset()` substitutes `{ENTITY}` / `{ENTITY_PLURAL}` from the tenant's
  `entityModel`, so the SAME tool reads "Look up the team…", "…the room…", "…the site crew…"
  per tenant. Verified across four vocabularies including an unconfigured fallback
  ("organisation").
- **Maintenance endpoints** — `POST /api/v1/:projectId/products/maintenance { op, dryRun }`,
  permission-checked (`knowledge.ingest`), gateway-routed, with a back-office BFF and UI.
  Ops: `reindex`, `dedupe-sizing-groups`, `purge-directory`. **dryRun defaults to true** and
  every op reports what it WOULD change first. `purge-directory` never deletes
  customer-registered entities — they are the tenant's own data and regenerable from no source.

### Still open
- `KnowledgePort.teams/registerTeam` remain for back-compat; entity lookup now belongs to
  BusinessPort and those should be retired once nothing calls them.
- Maintenance ops are platform-admin scope: `tenantAllowed()` returns true for any admin or
  the `platform` tenant BY DESIGN, so a platform admin can run a destructive op against any
  project. Non-admin identities are correctly restricted to their own tenant. If per-project
  operators should ever be blocked from cross-tenant maintenance, that policy is the place.
