# JourneyX — Architecture & Implementation Blueprint

> AI-powered journey orchestration & customer experience platform.
> This document designs the target architecture as an **evolution of the current
> `journeyAX` codebase** (OpenAI ReAct agent, Mongo vector RAG, REST microservices,
> Next.js 16, standalone black+yellow design system), not a greenfield rewrite.

---

## 0. Current State (grounded in the code)

| Capability | Today | Verdict |
|---|---|---|
| Conversational agent | `agent-commerce-service` — OpenAI ReAct `while`-loop, 4 phases enforced by prompt | Keep, wrap in a real orchestrator |
| RAG | `product-service` — Mongo Atlas `$vectorSearch` + regex fallback, `text-embedding-3-small` | Keep, generalize to multi-source |
| Tenant config | `project-service` — `TenantConfig` (theme/scope/persona) | Keep, expand into journey config |
| Gateway | `api-gateway` — hand-rolled REST proxy + tenant middleware + JWT guard | Keep, add BFF responsibilities |
| Chat UI | `journeyax-web` — chat + dynamic right panel (Clarify/Products/Guide/Quote/Ordered) | Already a 40/60 — extend it |
| Back-office | `backoffice-admin` (one ~1,550-line page) + DS mocks (14 screens) | Rebuild against real config APIs |
| Design system | Standalone black+yellow DS, not wired to app | Wire in |
| **Missing** | MCP tool layer, streaming, memory, workflow engine, event/audit pipeline, escalation, real order/booking, reasoning trace | **Build** |

**Guiding decision:** evolve the existing OpenAI + Mongo + Nest + Next stack. Introduce
the missing *layers* (orchestration, tool protocol, workflow, memory, audit) around it.

---

## 1. Target Architecture (text diagram)

```
┌───────────────────────────────────────────────────────────────────────┐
│ CHANNELS   Web chat · Mobile · WhatsApp · Kiosk · Embeddable widget     │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ SSE / WebSocket
┌───────────────────────────────▼───────────────────────────────────────┐
│ FRONTEND (Next.js 16)  40/60 shell · ChatPanel · ContextPanel          │
│   renders: references · journey steps · retrieved docs · products ·    │
│            recommendations · actions-taken · reasoning trace           │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ /api/chat (stream)
┌───────────────────────────────▼───────────────────────────────────────┐
│ BFF / GATEWAY (Nest)  auth · tenant resolve · rate-limit · session ·   │
│   request shaping · SSE fan-out · audit tap                            │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────┐
│ ORCHESTRATION LAYER (Journey Agent Runtime)                            │
│  ┌──────────┐ ┌─────────┐ ┌───────────┐ ┌────────────┐ ┌───────────┐   │
│  │ Intent   │→│ Context │→│ Journey   │→│ Next-Best- │→│ Tool /    │   │
│  │ Detect   │ │ Retrieve│ │ State     │ │ Action     │ │ Workflow  │   │
│  │          │ │ (RAG)   │ │ Reasoner  │ │ Planner    │ │ Executor  │   │
│  └──────────┘ └─────────┘ └───────────┘ └────────────┘ └───────────┘   │
│        │            │            │             │              │        │
│   LLM router (Claude/OpenAI/Ollama, fallback)  │   Prompt assembler    │
└───┬─────────────┬──────────────┬───────────────┬──────────────┬────────┘
    │             │              │               │              │
┌───▼───┐   ┌─────▼─────┐  ┌─────▼──────┐  ┌─────▼─────┐  ┌─────▼──────┐
│ MCP   │   │ Vector /  │  │ Memory     │  │ Workflow  │  │ Config     │
│ Tool  │   │ RAG store │  │ store      │  │ Engine    │  │ Service    │
│ Servers│  │ (Atlas)   │  │(short+long)│  │(state m.) │  │(journeys,  │
│catalog│   │ docs coll │  │ Redis+Mongo│  │ Temporal/ │  │ rules,     │
│order  │   │ embeddings│  │            │  │ XState)   │  │ prompts)   │
│booking│   └───────────┘  └────────────┘  └───────────┘  └────────────┘
│pricing│
│crm    │        ┌──────────────────────────────────────────┐
└───────┘        │ EVENT BUS (Kafka/Redis) → Analytics + Audit│
                 │ every intent, retrieval, tool call, action │
                 └──────────────────────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────┐
        ▼                                             ▼
  BACK-OFFICE (Next.js admin)                  DATA PLANE
  journeys · rules · knowledge · catalog       Mongo (config, sessions,
  segments · prompts · tools · escalation       docs, audit) · Redis
  analytics · admin/RBAC                        (memory, cache) · Vector
```

---

## 2. The 40/60 Chat Experience

**Left 40% — Conversation:** message stream (user = yellow bubble, agent = surface),
streaming tokens, inline chips for clarifying questions, typing/thinking state,
"agent is using tool X" affordances, escalation banner.

**Right 60% — Context Canvas** (tabbed/stacked, driven by `uiActions` the agent emits):

| Panel | Fed by | Shows |
|---|---|---|
| References | RAG retrieval | Source cards (title, snippet, doc type, confidence, deep link) |
| Journey Steps | Journey State Reasoner | Stepper: current stage, completed, next, branch taken |
| Retrieved Docs | Vector store | PDFs/spec sheets/policies with highlight |
| Product Data | `mcp-catalog` | Product cards, specs, price, stock, compatibility |
| Recommendations | Next-Best-Action | Ranked options / plan variations with rationale |
| Actions Taken | Tool/Workflow executor | Timeline: quote built, lead pushed, slot held |
| Reasoning Trace | Orchestrator | Step log: intent→retrieval→decision→tool (redactable for customer) |

**Contract that drives it:** the agent returns `{ message, uiActions[], trace[] }`.
Each `uiAction` = `{ target, op: 'set'|'append', payload }`. The current
`setPhase/showProducts/updateQuote/showGuide` pattern is exactly this — generalize
it into a typed `uiAction` envelope.

---

## 3. Agent Flow (the reasoning loop)

```
User input
  │
  ▼
[1] Intent Detection ──► {intent, entities, confidence, journeyType}
  │        (LLM classify + rules; fallback to clarify if low confidence)
  ▼
[2] Context Retrieval ──► RAG over knowledge sources filtered by
  │        tenant + journeyType + segment; + customer profile + memory
  ▼
[3] Journey State Reasoning ──► load journey definition + session state;
  │        determine current stage, satisfied/missing slots, valid branches
  ▼
[4] Business-Rule Evaluation ──► apply eligibility, pricing, compliance,
  │        escalation triggers (rule engine over context)
  ▼
[5] Next-Best-Action Planning ──► choose: ask clarifying Q | present plan |
  │        call tool | trigger workflow | escalate to human | answer+cite
  ▼
[6] Tool / Workflow Execution ──► MCP tool call(s) or workflow step;
  │        capture actions-taken + results
  ▼
[7] Response Synthesis ──► grounded answer + citations + uiActions + trace
  │        + memory write + event emit
  ▼
Stream to client
```

Steps 1–7 run as a **coded pipeline** (not just a prompt) so each is observable,
testable, and guardable — e.g. the **3-questions-max** rule lives in step 5 as code.

---

## 4. Behind-the-Scenes Architecture (per layer)

**Frontend (Next.js 16, App Router):** `/api/chat` opens an **SSE** stream; a reducer
applies `uiAction` events to panel state as they arrive (reducer already exists — add
streaming). Optimistic thinking/tool states from `trace` events.

**BFF/Gateway (Nest):** resolves tenant (subdomain/header), authenticates (JWT),
enforces rate limits + quotas, creates/loads `session`, proxies to orchestrator, taps
every event to the bus, returns SSE. Single public surface; services stay private.

**LLM Orchestration:** provider-agnostic **LLM router** (`claude` | `openai` | `ollama`)
with per-tenant model config + **fallback chain** (graceful degradation). Assembles the
prompt from: system template (tenant/persona) + journey state + retrieved context +
memory + tool schemas. Runs the step 1–7 pipeline. Fixes the `gpt-5.4-mini` default-model
risk by making model a validated config value.

**RAG / Vector:** keep Mongo Atlas `$vectorSearch`; generalize `documents` into a
multi-source store with `sourceType` (product | pdf | policy | faq | troubleshooting |
brand). Add **hybrid search** (vector + keyword) and **reranking**; token-budget the
context (already done). Ingestion pipeline stays (Firecrawl crawler → chunker →
classifier → embedder).

**Memory:**
- *Short-term* (session): Redis — rolling summary + slots + recent turns.
- *Long-term* (customer): Mongo — profile, preferences, past journeys, purchased items,
  embeddings of prior interactions for recall.
- Retrieved in step 2, written in step 7.

**Tool calling (MCP):** introduce an **MCP tool layer** — `mcp-catalog`, `mcp-pricing`,
`mcp-order`, `mcp-booking`, `mcp-crm`, `mcp-knowledge`. The orchestrator discovers tools
per tenant and passes their schemas to the LLM. Wrap the existing `product-service` as
`mcp-catalog` first. This is the missing keystone that makes "any backend" real.

**Workflow engine:** for multi-step, stateful, long-running actions (build quote →
reserve stock → create order → book plumber → send confirmation). **XState** for journey
state machines (in-process, light) and **Temporal** (or a durable queue) for cross-service
sagas with retries/compensation. Journey definitions compile into these machines.

**Event tracking:** every step emits a typed event (`intent.detected`,
`context.retrieved`, `rule.fired`, `action.planned`, `tool.called`,
`journey.stage.changed`, `escalation.raised`, `journey.completed`) to the bus →
analytics store + real-time dashboards.

**Audit logs:** append-only, immutable (hash-chained) record of every prompt, retrieval,
decision, tool call, and data access — per tenant, per session, with PII tagging.

---

## 5. Back-Office Configuration (what to build + how chat consumes it)

Each config domain is a Mongo collection + admin screen + a runtime consumer:

| Domain | Admin configures | Consumed by (runtime) |
|---|---|---|
| Journeys | Stages, clarifying questions, branch logic, slots, entry intents, completion criteria | Step 3 → compiles to XState machine |
| Business Rules | Eligibility, pricing/discount, compliance, quantity, region (condition→action) | Step 4 (rule evaluation) |
| Knowledge Sources | Docs/URLs/PDFs, sourceType, refresh cadence, access scope | Ingestion + Step 2 retrieval filters |
| Product/Catalog Mapping | Tenant catalog → journey products, compatibility, accessories, bundles | `mcp-catalog` + recommendations |
| Customer Segments | Personas, attributes, entitlements, pricing tiers | Prompt assembly + rule scoping |
| Prompt Templates | System prompt, persona voice, guardrails, per-journey overrides | Prompt assembler (Step 5/7) |
| Agent Tools | Which MCP tools enabled, params, auth, rate limits | Tool discovery per tenant |
| Escalation Rules | Triggers (low confidence, sentiment, value, explicit ask), routing | Step 5 escalation branch |
| Analytics | Funnels, KPIs, dashboards, exports | Event store queries |
| Admin/RBAC | Users, roles, data scopes, SSO, API keys, channels, brands | Gateway auth + tenant middleware |

**Consumption path:** Admin saves config → versioned in Mongo → published
(draft→staged→live) → orchestrator loads the tenant's **compiled config bundle**
(cached in Redis, invalidated on publish) at session start. Journeys become machines,
rules become a rule set, prompts become templates, tools become an allow-list.
**Config is data, not code** — no deploy to change a journey.

The DS already has these screens designed (Journey Builder with drag-reorder + branch
logic, Orchestration, Catalogue & Compliance, Channels, Integrations, Users & Roles,
Analytics) — build them against these APIs.

---

## 6. Comparison — and how JourneyX differs

| Dimension | ChatGPT / Claude | Manus | Cursor / AI IDE | JourneyX |
|---|---|---|---|---|
| Primary object | Open conversation | Autonomous task agent | Codebase | Customer journey |
| Context | Chat history + web | Task memory + tools | Repo + LSP | Journey state + catalog + profile + rules + knowledge |
| Right pane | None / canvas | Task/computer view | Diff, files, terminal | Journey context: steps, refs, products, actions, trace |
| Actions | Text (+ tools) | Broad computer use | Edit/run code | Governed commerce tools: quote, order, book, escalate |
| Governance | General safety | Loose | Dev-scoped | Business rules, segments, compliance, audit per tenant |
| Success metric | Helpful answer | Task done | Code merged | Journey completed / converted |
| Memory | Thread | Task | Workspace | Customer + journey long-term memory |

**The adaptation:** Cursor grounds in a repo and acts via code edits; JourneyX grounds in
a **journey definition + business rules + catalog** and acts via **governed commerce
tools**, with the right pane showing *journey progress and provenance* instead of diffs.
An "AI IDE for customer journeys" — deterministic where money/compliance are involved,
generative where conversation is.

---

## 7. Data Model (collections)

```
tenants            { _id, slug, brands[], channels[], modelConfig, sso, status }
journeys           { _id, tenantId, name, entryIntents[], stages[], slots[],
                     branches[], completionCriteria, version, status }
business_rules     { _id, tenantId, scope, condition, action, priority, version }
knowledge_sources  { _id, tenantId, type, uri, sourceType, scope, refreshedAt }
documents          { _id, tenantId, sourceType, content, embedding[], metadata }  // exists
catalog_map        { _id, tenantId, productRef, journeyTags[], compatibility[], bundles[] }
segments           { _id, tenantId, name, rules, entitlements, pricingTier }
prompt_templates   { _id, tenantId, journeyId?, role, body, guardrails, version }
tools              { _id, tenantId, mcpServer, name, enabled, params, rateLimit }
escalation_rules   { _id, tenantId, trigger, routing, sla }
sessions           { _id, tenantId, customerId, channel, journeyId, state,
                     slots, phase, memoryRef, createdAt }
messages           { _id, sessionId, role, content, uiActions[], trace[], ts }
customers          { _id, tenantId, profile, segmentIds[], history[], memory }
events             { _id, tenantId, sessionId, type, payload, ts }          // analytics
audit_log          { _id, tenantId, sessionId, actor, action, prevHash, hash, ts }
users/roles        { _id, tenantId, email, role, dataScope, ... }           // exists (auth)
```

Multi-tenancy: **`tenantId` on every row**, enforced at the data-access layer; optionally
DB-per-tenant for large enterprise brands.

---

## 8. API Contracts (key endpoints)

**Chat (streaming):**
```
POST /api/v1/chat   (SSE)
→ { sessionId?, tenant, channel, message, customerId? }
← event: token        data: { delta }
← event: uiAction     data: { target:"products", op:"set", payload:[...] }
← event: trace        data: { step:"intent", intent:"remodel", confidence:0.92 }
← event: action       data: { tool:"mcp-catalog.search", status:"ok" }
← event: done         data: { messageId, journeyStage:"orchestrate" }
```

**Sample intent + tool payload (internal):**
```json
{ "intent": "bathroom_remodel", "confidence": 0.94,
  "entities": { "room": "kids bathroom", "budget": 8000, "style": "modern" },
  "journeyId": "jr_caroma_remodel", "stage": "clarify",
  "missingSlots": ["dimensions", "ownership"] }
```
```json
{ "tool": "mcp-catalog.search_products",
  "args": { "query": "modern vanity", "filters": {"style":"modern"}, "budgetCents": 800000 } }
```

**Back-office config:**
```
GET/POST/PUT  /api/v1/admin/journeys          (versioned; ?status=draft|live)
POST          /api/v1/admin/journeys/:id/publish
GET/POST      /api/v1/admin/rules | /prompts | /tools | /segments | /knowledge
GET           /api/v1/admin/analytics/funnel?journeyId&range
```

**Config bundle (consumed by orchestrator):**
```
GET /api/v1/runtime/config?tenant=caroma
← { journeys[], rules[], prompts[], tools[], segments[], version }   // cached in Redis
```

---

## 9. Prompt Strategy

**Layered system prompt (assembled per turn):**
```
[BASE]      JourneyX agent identity + safety + citation rules
[TENANT]    Brand voice, persona (from prompt_templates)
[JOURNEY]   Current journey goal, stages, the ONE next objective
[STATE]     Slots filled/missing, phase, prior actions (prevents repeats)
[RULES]     Active constraints (budget, compliance, 3-questions-max)
[CONTEXT]   Top-k retrieved chunks w/ source ids for citation
[MEMORY]    Customer profile + relevant history
[TOOLS]     Enabled tool schemas
[FORMAT]    Must return message + uiActions + cite sources by id
```

**Sample (Caroma remodel, clarify stage):**
```
You are the Caroma Journey Agent. Goal: help the customer plan a bathroom
remodel and reach a confident, ordered plan. Current stage: CLARIFY.
Missing slots: [dimensions, ownership]. RULE: ask at most 3 questions, then
present a plan even if info is partial. Ground every product claim in the
provided CONTEXT and cite by [source_id]. Return clarifying questions as a
setPhase("clarify", questions[]) uiAction. Never invent SKUs or prices.
```

**Intent-classify prompt (step 1):** structured JSON output
`{intent, entities, confidence, journeyType}` with a fixed intent taxonomy per tenant.

---

## 10. Implementation Plan (phased)

**Phase 1 — Orchestration & UX backbone (2–3 wks)**
- Extract the ReAct loop into a coded **step 1–7 pipeline**; add SSE streaming.
- Generalize `uiActions` envelope + add **Reasoning Trace** and **References** panels.
- LLM router + fallback; fix model config.
- Wire the design-system tokens into the app.

**Phase 2 — Config-driven journeys (3–4 wks)**
- Build config collections + admin APIs (journeys, rules, prompts, segments).
- Rebuild `backoffice-admin` screens (Journey Builder, Rules, Prompts) against APIs.
- Compile journeys → XState; load config bundle at session start (Redis cache).
- Codify 3-questions-max + escalation triggers.

**Phase 3 — MCP tool layer + workflows (3–4 wks)**
- Wrap `product-service` as `mcp-catalog`; add `mcp-pricing/order/booking/crm`.
- Tool discovery per tenant; workflow engine for quote→order→booking saga.
- Real order/checkout + tradesperson booking (replace fakes); prices → integer cents.

**Phase 4 — Memory, analytics, audit, enterprise (3–4 wks)**
- Short/long-term memory; event bus + analytics dashboards; hash-chained audit log.
- RBAC/SSO, multi-brand/channel, rate limits/quotas, PII handling, secrets.

**Phase 5 — Extensibility**
- Design-variation image generation; channel adapters (WhatsApp/kiosk); connector SDK.

---

## 11. Acceptance Criteria (per capability)

- **Streaming chat:** tokens stream within 1s; `uiAction`/`trace` events render live; no full-buffer wait.
- **Intent detection:** ≥90% correct on a labeled tenant set; low-confidence routes to clarify, never a wrong tool.
- **RAG grounding:** every product/policy claim carries a resolvable citation; no fabricated SKUs/prices (validated against catalog).
- **Journey state:** never re-asks a filled slot; advances/branches per published journey; ≤3 clarifying questions before a plan.
- **Business rules:** a back-office rule change takes effect next session **without deploy**; conflicts resolve by priority.
- **Tool/workflow:** failed step triggers retry/compensation; actions-taken panel reflects true state; order/booking idempotent.
- **Escalation:** defined triggers hand off to the configured route within SLA, full context transferred.
- **Config→consumption:** publishing a journey updates the live config bundle within cache-TTL; draft edits don't affect live sessions.
- **Multi-tenant isolation:** no query returns cross-tenant data (enforced + tested); per-tenant model/prompt/tool config honored.
- **Audit:** every prompt, retrieval, decision, tool call, and data access recorded, immutable, PII-tagged.

---

## 12. Enterprise Cross-Cutting

- **Scalable:** stateless orchestrator (horizontal scale), Redis for session/memory/cache, event bus decouples analytics/audit, vector search on Atlas.
- **Secure:** JWT + SSO, per-tenant data scoping, secrets via vault/env, PII tagging + redaction in traces, immutable audit, tool-level authz/rate-limits, prompt-injection guards on retrieved content.
- **Extensible:** new journeys/rules/prompts = config; new backends = new MCP server implementing the standard tool interface; new channels = adapters over the same orchestrator.
- **Multi-everything:** tenant → brands → journeys → personas/segments → channels, all as data.
