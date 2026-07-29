# JourneyAX — Architecture, Layering & Restructure Guide

> **Purpose.** This is the *reference knowledge* for JourneyAX. It maps the "Under the Hood"
> architecture diagram onto the **actual codebase**, defines the **target folder structure** by
> architectural layer, specifies the **adapter/connector seams** that let new platforms (CRM,
> Commerce, ERP…) plug in, documents the **request flow** end-to-end, and gives a **gap analysis
> + phased plan** with the reasoning behind every choice.
>
> Golden rule: **build one vertical slice deep, not every box shallow.**
>
> _Note: this file replaces an earlier draft that described Kong Gateway / pnpm / Prisma. Those
> are NOT in the codebase — the real stack is a NestJS `api-gateway`, npm workspaces + Turborepo,
> and the MongoDB driver. This version reflects the code as it actually is (verified)._

---

## 1. The Layered Model (what each layer is for)

```
┌─ EXPERIENCE CHANNELS ─ Web · Mobile · WhatsApp · IVR · Kiosk · Dealer · CSR
│      why: many front-doors, ONE brain behind them.
├─ EXPERIENCE & AGENT LAYER ─ NLU · Intent · Memory · Dialog · Response · Guardrails
│      why: turns a message into a grounded, staged, human answer. THE product.
├─ AI ORCHESTRATION & TOOL ROUTING ─ Intent→Domain · Tool/MCP Router · Workflow · Session
│      why: decides WHAT to do and WHICH tool/data to touch. Controls the flow.
├─ INTEGRATION LAYER (API GATEWAY + ADAPTERS) ─ auth · routing · adapters per platform
│      why: the ONLY place that knows Shopify vs SAP vs Salesforce exists. Isolation.
├─ DOMAIN SYSTEMS ─ A) Commerce  B) Configurator  C) Fulfilment/Service  D) CRM/Support
│      why: the actual business capabilities, behind stable "ports".
└─ SHARED PLATFORM & DATA ─ Auth/SSO · Config · Audit · Events · Cache · Mongo · Vector
       why: cross-cutting concerns every layer reuses.
```

**The dependency rule (critical):** upper layers depend *downward through interfaces only*.
The Agent never imports Shopify. It calls a **Commerce Port**; an **adapter** behind that port
talks to Shopify/SAP/internal. Swap the platform → swap the adapter → nothing above changes.

---

## 2. Diagram Layer → Current Code (what exists / missing)

| Layer | Diagram boxes | In code today | Status |
|---|---|---|---|
| Channels | Web, Mobile, WhatsApp, IVR, Kiosk, Dealer, CSR | `apps/journeyax-web` (web only) | 🟡 1 of 7 |
| Agent layer | NLU, Intent, Memory, Dialog, Response, Guardrails, Tool select, Rec, Image gen | `agent-commerce-service` — all fused into ONE prompt + 8-loop | 🔴 exists but tangled |
| Orchestration | Intent→Domain, Orchestrator, MCP/Tool Router, Workflow, Session State | Gateway `SERVICE_REGISTRY` (routing only); no tool router/workflow/session | 🔴 mostly missing |
| Integration/Gateway | Gateway, Auth, Validation, Rate limit, Error, Logging | `api-gateway` (proxy + JWT + tenant middleware) | 🟡 partial |
| Adapters | Commerce / Configurator / Fulfilment / CRM adapter layers | `packages/configurator-core/connectors.ts` (stubs, unwired) | 🟡 embryo |
| A. Commerce | Catalog/PIM, Pricing, Inventory, Cart, Search, Content | `product-service` (RAG search over Mongo) | 🟡 search only |
| B. Configurator | Config, Room planner, BOM, 2D/3D, Image rec, Quote | `project-service` (tenant config); quote logic in web `JourneyContext` | 🔴 thin |
| C. Fulfilment/Service | Orders, Shipment, Returns, Payments, Appointment, Installer | `lead-service` (stub); order is a faked client-side ID | 🔴 stub |
| D. CRM/Support | Profile, Contact, History, Cases, Loyalty, Segmentation | `HubSpotConnector` stub; nothing wired | 🔴 stub |
| Platform | Auth/SSO, Config/Secrets, Audit, Observability, Cache, Broker, Flags, Encryption, CI/CD | `auth-service`, `organization-service`; no audit/events/cache/flags | 🟡 partial |
| Data | Operational DB, Vector DB, Warehouse, Object store | Mongo Atlas (`documents` coll + vector index) | 🟡 Mongo only |
| Knowledge (RAG) | KB, Catalog specs, Install PDFs, Policies, FAQs, Pricing rules | `journeyax-web/src/services/knowledge/*` ingestion + Mongo | 🟢 present (needs metadata) |

**Read this as:** the skeleton is all there; the agent layer is *fused* (should be split), the
orchestration + adapter wiring is *missing*, and domains C/D are *stubs*.

---

## 3. Target Folder Structure (organized by layer)

Principle: **the folder tells you the layer.** Microservices stay as `apps/*` (they deploy
separately), but names and shared `packages/*` are grouped so the architecture is visible.

```
journeyAX/
├── apps/
│   ├── channels/
│   │   ├── web-storefront/            (was journeyax-web) — customer 40/60 chat
│   │   └── backoffice-admin/          — admin config console
│   │
│   ├── agent-runtime/                 (was agent-commerce-service) — THE agent layer
│   │   └── src/
│   │       ├── pipeline/              — the controlled conversation flow
│   │       │   ├── intent-resolver.service.ts      (NLU + Intent Detection)
│   │       │   ├── session-state.service.ts        (Context & Memory / Session State)
│   │       │   ├── retrieval-router.service.ts     (routes RAG by intent — see §5)
│   │       │   ├── dialog.service.ts               (Dialog Management, stage machine)
│   │       │   ├── response-generator.service.ts   (grounded Response Generation)
│   │       │   ├── grounding-validator.service.ts  (Guardrails: is it grounded?)
│   │       │   └── orchestrator.service.ts         (runs the pipeline in order)
│   │       ├── prompts/               — base + mode(business|technical) + stage snippets
│   │       ├── llm/                   — LLM router (OpenAI now; Claude/Ollama later)
│   │       └── agent.controller.ts
│   │
│   ├── orchestration/
│   │   └── api-gateway/               — gateway + intent→domain routing + guardrails
│   │
│   └── domains/                       — the business capabilities (A/B/C/D)
│       ├── commerce/  product-service        (A: catalog, pricing, inventory, search)
│       ├── configurator/  project-service    (B: config, room planner, BOM, quote)
│       ├── fulfilment/  order-service (NEW)  (C: orders, appointments, installer)
│       └── crm/  customer-service (NEW)      (D: profile, cases, history, segments)
│
├── packages/
│   ├── shared-types/                  — cross-cutting DTOs (exists)
│   ├── integration/                   — ★ ADAPTER LAYER (ports + adapters + registry)
│   │   └── src/
│   │       ├── ports.ts               — CommercePort, CrmPort, FulfilmentPort, ConfiguratorPort
│   │       ├── registry.ts            — resolves adapter by tenant + platform
│   │       └── adapters/
│   │           ├── commerce/  standalone · shopify · commercetools · sap
│   │           ├── crm/       standalone · salesforce · hubspot
│   │           └── fulfilment/ standalone · …
│   │   (absorbs today's configurator-core/connectors.ts)
│   │
│   ├── agent-core/                    — shared agent contracts (intent enums, stage types,
│   │                                     toolresult shapes, uiAction envelope)
│   ├── platform/                      — audit, events (bus), cache, config-loader, logger
│   ├── knowledge/                     — ingestion + chunker + embedder (move from web)
│   └── design-system/                 — black+yellow tokens (wire the standalone DS in)
│
└── docs/                              — this file, journeyx-architecture-design, brand-guide
```

Why this shape:
- **`apps/channels|agent-runtime|orchestration|domains`** = the diagram's rows, visible on disk.
- **`packages/integration`** = the single seam where external platforms live. Adding
  CommerceTools = one new file in `adapters/commerce/`. Nothing else changes.
- **`packages/knowledge`** = ingestion is a *platform capability*, not a web-app detail;
  it's currently buried in `journeyax-web/src/services/knowledge` (wrong layer).

---

## 4. The Adapter Layer (how new platforms plug in)

A **Port** is a stable business interface the app depends on. An **Adapter** implements a port
for one platform. A **Registry** picks the adapter per tenant.

```
Agent / Domain code
      │  depends on ↓ (never on a vendor)
   CommercePort  ── searchProducts · getProduct · getPricing · checkInventory
      │                · createCart · createCheckout
      ├── StandaloneCommerceAdapter → internal product-service + Mongo   (mode=standalone)
      ├── ShopifyCommerceAdapter    → Shopify Admin API                  (mode=shopify)
      ├── CommercetoolsAdapter      → commercetools                      (mode=commercetools)
      └── SapErpAdapter             → SAP RFC/OData                      (B2B pricing/inventory)

   CrmPort ── upsertContact · pushLead · createCase · getCustomer · getSegments
      ├── StandaloneCrmAdapter  → internal customer-service
      ├── SalesforceCrmAdapter  → Salesforce
      └── HubSpotCrmAdapter     → HubSpot

   FulfilmentPort ── createOrder · trackShipment · createReturn · bookAppointment · assignInstaller
      └── StandaloneFulfilmentAdapter → internal order-service

   ConfiguratorPort ── createDesignOptions · generateBom · estimateCost · saveDesign
      └── StandaloneConfiguratorAdapter → internal project-service
```

**Tenant chooses its platform via config** (`TenantConfig` / `IntegrationConnection`):
```
tenant "caroma"  → { commerce: standalone, crm: salesforce, fulfilment: standalone }
tenant "acme"    → { commerce: shopify,     crm: hubspot,    fulfilment: standalone }
```
The registry reads that and hands the agent the right adapter. **The agent code is identical for
every tenant.** That is the whole point of the layer.

> Migration note: `packages/configurator-core/connectors.ts` already has this idea
> (ICatalogConnector etc.). We formalize it into `packages/integration` with **ports named by
> business domain** (Commerce/CRM/Fulfilment/Configurator) instead of by capability
> (Catalog/Checkout), and add the internal "standalone" adapters that are missing.

---

## 5. Request Flow (end-to-end, target)

```
[web-storefront] ChatPanel
   │  POST /api/chat  (SSE)
   ▼
[orchestration] api-gateway  → auth · resolve tenant · rate-limit · load tenant config bundle
   │  /api/v1/agent/chat
   ▼
[agent-runtime] orchestrator.service — runs the pipeline IN ORDER:
   1 intent-resolver   → {intent, stage, known_info, missing_info, needsRetrieval, mode}
   2 session-state     → load/merge session (Mongo), fill known/missing slots
   3 dialog            → decide next action (ask | recommend | guide | quote | escalate)
   4 retrieval-router  → IF needsRetrieval: pick sources by intent, call CommercePort/Knowledge
   5 response-generator→ ONE grounded LLM call, stage-scoped prompt, cites sources
   6 grounding-validator→ (technical mode only) grounded? no repeat? has next action? ≤1 retry
   7 emit uiActions + trace + write session + emit event(audit/analytics)
   │
   ▼  tools/data are reached ONLY through ports:
[packages/integration] registry.resolve(tenant).commerce → StandaloneCommerceAdapter
   │
   ▼
[domains/commerce] product-service → Mongo (vector + metadata filter + score threshold)
```

Compare to **today**: web → gateway → agent (one open prompt, 8-loop, calls product-service by
raw REST, no session, no validation). The flow above is the *same services*, re-sequenced into
controlled steps with a port seam.

---

## 5b. P0 Corrections Applied (2026 — agent loop + retrieval)

The full pipeline split (§5) is the target. As a first, in-place correction (no renames), the
following bugs that caused **looping** and **inaccurate / invented answers** were fixed in the
existing `agent-commerce-service` and `product-service`. Verified against live data
(4,749 docs; `brand` stored in both top-level and `metadata.brand`, matching all docs).

**Corrected agent loop (`agent.service.ts`):**
```
loop (max 6):
  call LLM (tool_choice = forceText ? 'none' : 'auto')
  ├─ no tool_calls OR forceText  → take text, STOP
  ├─ searchKnowledge  → run search (capped at 3/turn), feed result back, loop
  └─ UI tools only    → collect uiActions, set forceText=true → next call MUST return text
after loop: if final message is tool-only (no text) → one 'none' pass to get text
```
Why: previously *every* UI tool call re-triggered the loop with no exit, so the model kept
emitting `showProducts`/`setPhase` until it burned all 8 iterations and returned an empty,
tool-only message — the "looping". Now UI tools are fire-and-forget and the turn always
terminates with prose.

**Fixes applied:**
| Fix | File | Was → Now |
|---|---|---|
| Loop never terminated on UI tools | `agent.service.ts` | 8-loop free-for-all → forced-text termination + tool-only safety net |
| Unbounded searches → retrieval loop | `agent.service.ts` | uncapped → **max 3 searches/turn** |
| Prompt allowed inventing install steps | `agent.service.ts` (Rule 2) | "you MAY generate generic steps" → **NO invented steps**, recommend a plumber |
| Retrieved PDFs during discovery | `agent.service.ts` (Rules 13–14) | always search → **intent-gated retrieval** (ask first, retrieve only when needed) |
| Fake history "compaction" dropped context | `agent.service.ts` | placeholder that deleted middle turns → **full history** (no lost context / orphaned tool pairs) |
| Context budget starved the model | `product.service.ts` | `MAX_TOKEN_BUDGET = 1500` (one chunk) → **6000** |
| Category `$exists` broke vector search | `product.service.ts` | `$or`+`$exists` inside `$vectorSearch` (throws → silent regex) → **plain equality** |
| Silent vector→regex fallback | `product.service.ts` | unlabelled → **loud VECTOR/REGEX logging + top scores**, plus unfiltered semantic retry |
| Invalid fallback model id | `agent.service.ts` | `gpt-5.4-mini` → `gpt-4o-mini` (set `LLM_MODEL` in `.env` for your model) |

**How to verify on your machine** (this sandbox can't reach Atlas vector search reliably):
run the app and watch `product-service` logs — you should see
`VECTOR search: N results, top scores [...]`. If you instead see
`REGEX (keyword) fallback`, the Atlas `vector_index` is missing `filter` fields for
`metadata.brand/type/category` — declare them in the index definition.

### Also implemented in this pass (adapter seam + pipeline)
- **KnowledgePort** (`packages/integration`): the agent now retrieves via
  `adapterRegistry.getKnowledge(tenantId).search(...)` — no hardcoded service URL. Swap a
  tenant's knowledge/commerce platform in the registry and the agent is unchanged.
  Adapters present: `commerce/{standalone,shopify}`, `crm/salesforce`, `knowledge/standalone`.
- **Controlled pipeline** (`apps/agent-commerce-service/src/pipeline/`): each turn now runs
  `intent-resolver` (structured classify) → `retrieval-router` (intent-gated policy injected
  into the prompt) → generation loop → `grounding-validator` (technical mode). The response
  now carries `intent` + a `trace[]` (additive fields) for the Reasoning-Trace panel.
- Still TODO (structural): server-side session persistence (Mongo), moving the big
  SYSTEM_PROMPT into `prompts/{base,business,technical,stage}`, and SSE streaming.

---

## 6. Do you need a Back Office? — Yes. Here's exactly what it configures.

The agent is **config-driven**. The back office (`backoffice-admin`) is where a non-developer
sets that config; the agent-runtime consumes it at session start (cached in Redis).

| Back-office screen | Writes to (collection) | Consumed by (runtime step) |
|---|---|---|
| Journeys / Stages | `journeys` | dialog.service (stage machine) |
| Business Rules | `business_rules` | dialog + response-generator |
| Prompt Templates | `prompt_templates` | prompts/ assembler |
| Knowledge Sources | `knowledge_sources` | knowledge ingestion + retrieval-router |
| Catalog Mapping | `catalog_map` | CommercePort / recommendations |
| Segments / Personas | `segments` | intent-resolver + prompt |
| Integrations (connectors) | `integration_connections` | **integration registry** (which adapter) |
| Tools | `tools` | tool router (enabled tools per tenant) |
| Escalation Rules | `escalation_rules` | dialog (handoff branch) |
| Users & Roles / SSO | `users`,`roles` | gateway auth |
| Analytics | (reads `events`) | dashboards |

You already have `backoffice-admin` (1 page) + `project-service` (tenant config) +
`organization-service` (RBAC). This becomes the config API layer above them.

---

## 7. Gap Analysis (what to build, ranked)

**P0 — fix the flow that's broken today (agent-runtime, product-service):**
1. Split the fused prompt into the 6-step pipeline (§5). *Kills loops + wrong answers.*
2. Retrieval routing by intent (don't fetch PDFs during discovery).
3. product-service: raise token budget (1500→~6k), metadata filters, score threshold,
   vector-vs-regex logging. *Kills starvation + silent keyword fallback.*
4. Server-side session state (Mongo) instead of client-passed `state`.
5. Grounding validator (technical mode), remove "you may invent steps".

**P1 — the seams (integration + orchestration):**
6. `packages/integration` ports + registry + standalone adapters (scaffolded now).
7. Wire the agent to call CommercePort/CrmPort, not raw REST.
8. Gateway: intent→domain routing, request validation, rate limit, audit tap.

**P2 — the missing domains:**
9. `order-service` (fulfilment): real order + appointment booking (replace fakes).
10. `customer-service` (CRM): profile/cases/history behind CrmPort.

**P3 — platform + channels:**
11. `packages/platform`: audit log (hash-chained), event bus, Redis cache, config loader.
12. Back-office config screens (§6). Additional channels (WhatsApp/IVR) as adapters.

**Do NOT do yet:** multi-agent orchestration (keep ONE controller agent), 2D/3D visualizer,
loyalty, warehouse/object-store. They're on the diagram as the *destination*, not the sprint.

---

## 8. Rename / Refactor Plan (with rationale) — requires sign-off

**Safe, additive** (done without breaking running code):
- ✅ Add `packages/integration` (new).
- ✅ Add `packages/agent-core`, `packages/platform` (new).
- ✅ Add/replace `docs/ARCHITECTURE.md` (this file).

**Renames/moves** (break imports, env & `SERVICE_REGISTRY` — do one at a time, build & test after):
- ⚠️ `agent-commerce-service` → `agent-runtime`
- ⚠️ `journeyax-web` → `channels/web-storefront`
- ⚠️ `product-service` → `domains/commerce`, `project-service` → `domains/configurator`
- ⚠️ Move `journeyax-web/src/services/knowledge` → `packages/knowledge`
- ⚠️ Absorb `configurator-core/connectors.ts` → `packages/integration/adapters`
- ⚠️ Add `order-service`, `customer-service` under `domains/`

**Why staged:** npm-workspaces + Turborepo means folder renames change workspace paths, import
specifiers, `SERVICE_REGISTRY` URLs, and env names. Big-bang = everything red at once. One move
+ build + fix + commit keeps you always-green.

---

## 9. Why this design (the reasoning to keep in your head)

- **One visible agent, controlled internally.** Customers see one assistant; inside, a
  deterministic pipeline decides each step. Free-form single-prompt agents loop and hallucinate
  (the current bug). Control = reliability.
- **Ports, not vendors.** The moat is the journey + data + orchestration, not any platform.
  Isolating vendors behind adapters means Caroma-on-standalone and Acme-on-Shopify run the *same*
  agent. Sales can say "any backend" and mean it.
- **Config over code.** Journeys/rules/prompts/connectors are data edited in the back office, so
  onboarding a new brand/journey is configuration, not a deploy.
- **Vertical slice first.** Web → agent pipeline → CommercePort → product-service → Mongo,
  working end-to-end, beats 30 half-built boxes. Depth over breadth.
```
