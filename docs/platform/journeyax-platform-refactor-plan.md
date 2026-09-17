# JourneyAX Platform Refactor Plan

**Companion to:** *JourneyAX Platform Architecture & Product Requirements* v1.0 (17 September 2026)
**Status:** engineering plan, no code changed yet · **Owner:** JourneyAX engineering · **Branch:** `JourneyAX-dev-v3-dragonshield`

This plan turns the PRD into work the team can start on Monday. It is grounded in the current repository
(`apps/agent-commerce-service`, `apps/product-service`, `apps/project-service`, `apps/journeyax-web`,
`apps/backoffice-admin`, `packages/*`) and names the files each step touches. Requirement IDs (CORE-, BP-, JE-,
NBQ-, CTX-, PM-, CAP-, CONV-, GO-, STU-, OBS-, SEC-, NFR-) refer to the PRD.

---

## 1. Architecture decision (ADR-001)

> JourneyAX Core contains no industry-specific business logic. Tenant and vertical behaviour is supplied by a
> versioned **Business Pack** (vocabulary, entities, relationships, rules, journey definitions, capability
> bindings, conversation policy, skills, evaluations). The **Journey Engine** owns process state and the next
> decision. **Enterprise services** own business truth. The **LLM** owns language understanding and phrasing and
> is never the source of a fact, a price, a compatibility claim or a stage transition. Every publish is gated by
> the tenant's evaluation suite.

Consequences the team accepts:

- No new tenant-specific branch, word or nudge enters `agent-commerce-service` during the migration (PRD §17.1).
- Every prompt nudge removed is replaced by journey state, a rule, a policy or a capability — never just deleted.
- Existing deterministic guards (bag, pricebook grounding, sold-out, purchase limits, exact-code lookup) are
  wrapped, not rewritten.
- New tenants onboard on the Business Pack model from R2 onward even while older tenants migrate.

---

## 2. Target architecture on the current codebase

```
CUSTOMER / ASSOCIATE
        │
JourneyAX Go  (apps/journeyax-web) ── structured UI instructions ── component registry (packages/ui-cards)
        │  message · UI event · attachment · actor
        ▼
CORE TURN PIPELINE  (apps/agent-commerce-service/src/pipeline/*)  ← ONE pipeline, thin model/transport adapters
  1 receive → 2 interpret → 3 load project + pack → 4 validate facts → 5 resolve stage → 6 next decision
  → 7 assemble context → 8 execute capabilities → 9 validate → 10 phrase → 11 render → 12 persist + trace
        │                       │                        │
   Business Pack           Journey Engine           Context Engine
   (config, versioned,     (goal · stage · facts     (project facts · rules ·
    loaded per tenant)      · missing · decision      candidates · knowledge ·
                            · allowed/blocked)         allowed actions · policy)
        │
CAPABILITY RUNTIME  (packages/integration + product-service + agent commerce services)
  discover · retrieve · recommend · compare · configure · validate · calculate · price · check_availability
  · build_solution · quote · approve · order · reorder · schedule · service · history
        │
ENTERPRISE / PLATFORM SERVICES: catalog, pricebook, inventory, quote, order, customer, delivery, knowledge
        │
PROJECT WORKSPACE  (journeyx.projects — new)  ← canonical state; sessions become evidence

JourneyAX Studio  (apps/backoffice-admin) — Business · Journeys · Rules · Capabilities · Experience · Evaluation · Publish
```

### 2.1 Where each layer lives today, and where it goes

| Layer | Today (files) | Target | PRD IDs |
|---|---|---|---|
| Core turn pipeline | `agent.service.ts` (6,968 lines; three turn paths: open-model, gpt stream, gpt non-stream) | `src/pipeline/turn/*` — one `runTurn()` with stage functions; `src/adapters/{openai,openmodel}.ts` only for transport | CORE-002, CORE-005, NFR-003 |
| Business Pack | `ProjectConfig` (332 fields), `persona.journeyGuidance` prose, `contextDimensions`, `handoffs`, `purchaseLimits`, `storageGuide`, `demoCustomers`, `scenarios`, `business_rules` collection, `{tenant}_domain_glossary`, `skills/<tenant>/` | `packages/business-pack` schema + loader; pack stored per tenant version in `journeyax.business_packs`; Studio edits it | BP-001…BP-010, CORE-004 |
| Journey Engine | `pipeline/journey-memory.ts` (phase, capability ledger, dimensions, lastShown…), `retrieval-router.ts`, 62 per-turn nudges | `src/engine/journey-engine.ts`: stage resolution, required facts, next decision, allowed/blocked capabilities from the pack's journey definition | JE-001…JE-010, NBQ-001…NBQ-005 |
| Context Engine | inline prompt assembly at two sites, `deriveRetrievalContext`, `TurnSearchMemo`, demo pre-reads | `src/engine/context-builder.ts`: categorised, budgeted, provenance-tagged context per task | CTX-001…CTX-007, SEC-004 |
| Capability Runtime | 89 tool defs in `agent.service.ts`, `CAPABILITY_TO_TOOL`, `packages/integration` adapters, `QuoteService`, `OrderService`, product-service endpoints | `src/capabilities/registry.ts` with generic capability contracts; tenant bindings in the pack; existing tools become implementations | CAP-001…CAP-009 |
| Project Workspace | `pipeline/session-store.ts` (messages, steps, journeyState per session) | `journeyx.projects` + `src/engine/project-store.ts`; session keeps transcript and links to `projectId` | PM-001…PM-008 |
| JourneyAX Go | `ChatPanel.tsx`, `CardStage.tsx`, `packages/ui-cards` json-render templates, `CartPanel` | keep; add `ProjectSummary`, `ConfigurationSummary`, `BOM`, `ApprovalPanel` components; UI actions post typed events to the pipeline | GO-001…GO-007 |
| Studio | `backoffice-admin` tabs (AI Orchestration, Journey Builder canvas, Business Rules, Cards & Theme, Journey Overview) | regroup into Business / Journeys / Rules / Capabilities / Experience / Evaluation / Publish | STU-001…STU-010 |
| Evaluation | 3 unit test files, 1 eval file, scratchpad `run-scenarios.sh`, DS `scenarios[]` | `packages/eval` runner + `evaluations/*.json` per pack + CI gate | §16, OBS-001 |

### 2.2 Vertical logic to extract from Core (found by scan)

| Symptom | Location | Replacement |
|---|---|---|
| `bathroom_remodel`, `leak_repair`, `installation_help` intents | `pipeline/intent-resolver.ts` | generic goals `start_project · modify_project · replace_item · reorder · troubleshoot · configure · compare · quote · purchase · service · support`; pack `goalPatterns` map tenant words to them |
| Wet-area / leak-location / gender question banks | `agent.service.ts` `buildDomainClarify`, `synthGenderClarify`, `extractQuestionsFromModelResponse` | pack `requiredFacts` with `priority`, `reason`, `options`; engine selects, model phrases |
| Jersey / garment / roster / design-line handling (104 mentions) | `agent.service.ts`, prompts | Augusta pack: vocabulary + rules + capability bindings (`configure`, `validate`) |
| "right panel", trade vocabulary, NZ branch names in prompts | prompts + PlaceMakers guidance | pack vocabulary + conversation policy |
| Per-turn nudges (SET ASK, GIFT ASK, STORAGE ASK, DETAIL ASK, COMPARISON ASK, CARDS CARRY THE ITEMS, CHIPS AVAILABLE …) | `agent.service.ts` prompt sites | journey stage `allowedCapabilities`/`blockedCapabilities`, conversation policy, capability contracts |
| Capability ledger keys (`installationGuide`, `warranty`, `configurator`) | `journey-memory.ts` | generic capability registry |

---

## 3. Canonical objects (implement as TypeScript types + zod schemas in `packages/business-pack` and `packages/journey-core`)

```ts
// packages/journey-core/src/types.ts (new)
type Goal = 'start_project'|'modify_project'|'replace_item'|'reorder'|'troubleshoot'|'configure'|'compare'|'quote'|'purchase'|'service'|'support';

interface Fact { key: string; value: unknown; type: 'string'|'number'|'boolean'|'enum'|'object';
  source: 'customer'|'inferred'|'capability'|'ui'|'account'; confidence: number; capturedAt: string;
  validUntil?: string; revalidate?: 'never'|'per-session'|'before-use'; }

interface Decision { decisionId: string; type: string; options?: unknown[]; selectedValue: unknown;
  rationale?: string; source: 'customer'|'engine'|'associate'; timestamp: string; }

interface ProjectWorkspace { projectId: string; tenantId: string; packVersion: string; principal?: { id: string; role: string };
  goal: Goal; journeyId: string; currentStage: string; name?: string;
  facts: Record<string, Fact>; decisions: Decision[]; selectedObjects: SelectedObject[];
  openQuestions: OpenQuestion[]; actions: ActionRecord[]; commercial: { quoteId?: string; orderIds: string[] };
  status: 'active'|'completed'|'handed_off'|'archived'; history: Transition[]; }

interface StageDefinition { stageId: string; entryConditions: Condition[]; requiredFacts: RequiredFact[];
  optionalFacts: string[]; allowedCapabilities: CapabilityId[]; blockedCapabilities: CapabilityId[];
  exitConditions: Condition[]; nextDecisionPolicy?: 'priority'|'dependency-first'; }

interface RequiredFact { fact: string; priority: number; reason: string; dependsOn?: string[];
  options?: string[]; askWhenMissing: boolean; inferFrom?: { capability?: CapabilityId; aliases?: Record<string,string[]>; derive?: { from: string; map: Record<string,string> } }; }

interface JourneyDefinition { journeyId: string; version: string; goalPatterns: { goal: Goal; triggers: string[] }[];
  stages: StageDefinition[]; transitions: Transition[]; completionConditions: Condition[];
  handoffConditions: Condition[]; revalidationRules: RevalidationRule[]; }

interface Capability { capabilityId: CapabilityId; inputSchema: ZodSchema; outputSchema: ZodSchema;
  sideEffect: 'none'|'write'; freshness: 'live'|'cacheable'|'static'; authPolicy: 'any'|'signed-in'|'staff'|'associate'; }

interface UIInstruction { componentType: string; dataRef: string; actions: string[]; presentationHints?: Record<string,unknown>; }
```

**Data rule (PRD §9):** chat messages are evidence; `ProjectWorkspace` is the source of truth. `session-store.ts`
keeps the transcript and `projectId`; `journeyState` is migrated into the project and then retired.

---

## 4. Business Pack contract and the three existing tenants

```
business-pack/<tenant>/
  manifest.json              packId, version, inherits (vertical pack), createdBy, changelog
  profile.json               company, commerce mode (bag|quote), currency, regions, personas, north-star benchmark
  vocabulary.json            terms: { term, meaning, synonyms[], canonical concept, appliesTo[], importance }
  entities.json              Product, Variant, Category, Project, Room/JobSite, Account, Branch …
  relationships.json         requires | compatible_with | substitute_for | accessory_for | goes_with | restricted_by  (+ source: data|curated)
  rules.json                 { ruleId, scope, appliesWhen, inputs, expression|handler, outcome, explanation, priority }
  journeys/<journey>.json    JourneyDefinition (stages, required facts, allowed/blocked capabilities, completion)
  capability-bindings.json   capabilityId → implementation + connection ref + environment
  conversation-policy.json   tone, preferred/deprecated terms, one-question policy, explanation depth, summary cadence
  skills/<skill>/SKILL.md    on-demand techniques for the model (see §6)
  evaluations/<scenario>.json  PRD §16.2 scenario contract
```

| Element | Caroma (home) | PlaceMakers (construction B2B) | Dragon Shield (retail) |
|---|---|---|---|
| Vocabulary | back-to-wall, set-out, in-wall cistern, mixer | GIB, dwang, H3.2, SG8, CMU, pack size, Click & Collect | Standard vs Japanese size, Commander/EDH = Magic, double-sleeve |
| Entities | Room, Fixture, PlumbingLayout, Finish, Project | Project, JobSite, Material, Specification, Branch, Account, Delivery | Game, Deck, Collection, Set, Profile |
| Relationships | requires, fits_with, accessory_for | requires, approved_substitute, compliant_with, available_at | goes_with (collections), fits (capacity guide) |
| Journeys | new bathroom, remodel, replacement, troubleshooting | project BOM, spec-to-product, replenishment, quote, job-site delivery, returns | protect a deck, store, complete the set, gift, custom, returning, support |
| Rules | plumbing compatibility, plumber required, regional availability | spec compliance, pack rounding, branch stock gate, repair-before-replace, returns policy | card-size gate, one Dragonfall per person, final sale, sold-out never buyable |
| Capabilities | discover, recommend, validate(plumbing), schedule(consultation), quote | discover, calculate(BOM/deck/GIB), price, check_availability(branch), quote, order, service(returns) | discover, recommend, compare, build_solution(set), purchase(bag), history, service |
| Policy | homeowner-friendly, explain constraints | trade-aware, concise, abbreviations | warm, show-first, at most two chips |

Today's config already holds most of this in pieces (`contextDimensions` = required facts; `storageGuide`,
`purchaseLimits`, `handoffs` = rules; `scenarios` = evaluations; `business_rules` = rules; glossary =
vocabulary; collections = relationships). R2 gathers them into the pack shape without losing anything.

---

## 5. Delivery plan

Order follows PRD §17/§18 with one change agreed in review: the evaluation gate moves first, because every later
step changes behaviour and must be measured (P10). Effort assumes one engineer full-time on the platform plus one
half-time on Studio from R5; each increment ships behind the current behaviour with regression evidence.

### R0 — Evaluation gate (week 1, 2–3 days)
- Promote `scratchpad/run-scenarios.sh` and `verify-placemakers-reindex.sh` into `packages/eval` (`runScenario(tenant, scenario)` → trace-based assertions).
- Scenario contract = PRD §16.2: `initialState`, `turns[]`, `expectedIntent/facts`, `expectedStage`, `expectedNextDecision`, `expectedCapabilities`, `expectedUI`, `forbidden[]`.
- Seed: 12 Dragon Shield scenarios (already in config `scenarios[]`), 10 PlaceMakers conversations from `journeyx.sessions` (returns, small hole, decking timber, SKU 5080443, GIB screws, mower battery, laundry makeover, branch stock, wallboard install, Caroma flush), 8 Caroma flows.
- Assert on the existing turn trace (`trace` events: intent, retrieval-policy, tool-call, uiAction) so it works before the refactor.
- **Exit:** `pnpm eval --tenant placemakers` prints pass/fail per scenario; CI job runs it on PRs touching the agent.

### R1 — One turn pipeline (weeks 1–2)
- New `src/pipeline/turn/` with stage functions `interpret → loadProject → validateFacts → resolveStage → nextDecision → assembleContext → executeCapabilities → validate → phrase → render → persist`.
- Move the three paths' shared logic into these stages; leave `openai.adapter.ts` (function calling, stream/non-stream) and `openmodel.adapter.ts` (TOOL_CALL syntax) as transport only.
- Keep every existing guard as a stage helper: `applyStorefrontCartCommand`, `groundItemFacts`, `enforceItemDesignability`, `attachBundleFacts`, `applyDimensionHardFilter`, exact-code lookup.
- **Exit:** R0 suites pass identically on all three transports; `agent.service.ts` under 2,000 lines; one dispatch site per feature (CORE-002).

### R2 — First Business Pack: PlaceMakers, then Dragon Shield (weeks 3–4)
- `packages/business-pack`: zod schemas for the contract in §4, loader with inheritance (`inherits`), validation (BP-009), versioning (BP-010) stored in `journeyax.business_packs`.
- Migration script (TypeScript, committed under `apps/project-service/src/scripts/`) that builds the pack from today's config: dimensions → requiredFacts; guidance paragraphs → journey stages + policy; rules collection → rules.json; glossary → vocabulary; collections/relationships → relationships; scenarios → evaluations; `skills/<tenant>` → pack skills.
- Replace `intent-resolver.ts` taxonomy with generic goals + pack `goalPatterns`; delete `buildDomainClarify`/`synthGenderClarify`, move their questions into the Caroma/PlaceMakers/Augusta packs as required facts.
- **Exit:** static scan finds no tenant or vertical words in `agent-commerce-service/src` outside tests (CORE-001); PlaceMakers and Dragon Shield run from packs; suites pass.

### R3 — Journey Engine + Context Builder (weeks 4–6)
- `journey-engine.ts`: stage resolution from facts and transitions (JE-002/003), required-fact ranking (NBQ-001), allowed/blocked capabilities enforced at tool-set build time (JE-005 — extends today's retrieval-policy tool filtering), one-question policy (NBQ-003), no duplicate asks (NBQ-004), out-of-order facts (JE-006).
- `context-builder.ts`: categories with budgets and provenance (CTX-002/004/005): project facts, applicable rules, candidates (via `TurnSearchMemo`), knowledge, allowed actions, conversation policy. Model prompts shrink to: platform base + pack policy + stage instruction + context. The 62 nudges are retired one by one, each mapped to a stage, rule or policy (§17.1).
- **Exit:** prompt size per turn measured before/after (target ≤ 40% of today); A1 (no recommendation before critical facts) and A3 (terminology) pass.

### R4 — Project Workspace (weeks 6–7)
- `journeyx.projects` collection + `project-store.ts`; `ProjectWorkspace` as in §3; facts carry source/confidence/validUntil (PM-002, PM-007); transitions and decisions logged (PM-008).
- Session ↔ project link; "continue the warehouse project" / "same as last time" resume flows; sample-customer profiles become project seeds; Go shows `ProjectSummary`.
- **Exit:** A2 (resume without re-asking) passes for Dragon Shield and PlaceMakers.

### R5 — Capability Registry + Studio regroup (weeks 7–9)
- `src/capabilities/registry.ts` with the generic set (`discover, retrieve, recommend, compare, configure, validate, calculate, price, check_availability, build_solution, quote, approve, order, reorder, schedule, service, history`), typed contracts (CAP-002), provenance (CAP-009), idempotency on writes (CAP-006), business-safe errors (CAP-007).
- Bindings per tenant in the pack; today's 89 tools become implementations behind these names. `compatibility` and `substitute` become real capabilities over `relationships.json` and catalogue data (CAP-004).
- Studio: regroup existing screens into Business / Journeys / Rules / Capabilities / Experience / Evaluation / Publish; publish workflow validates the pack and runs the suite (STU-006/008); rollback = previous pack version (STU-007).
- **Exit:** A5, A6, A7, A10 pass; Studio publish blocked on a failing suite.

### R6 — Quality platform and hardening (weeks 9–10)
- Model comparison runs (A8), OBS-001 turn trace surfaced in Conversations, business metrics (OBS-002), redaction (OBS-004), tenant-isolation tests (SEC-001), authorization on writes (SEC-002).
- **Exit:** PRD §19.2 Definition of Done reviewed item by item.

### Not in this plan (PRD §5.2)
No graph database, no microservice rewrite, no per-stage agents, no new model, no full Studio rebuild, no bulk prompt rewrite. Mongo stays. One primary LLM stays (per-tenant model choice remains config).

---

## 6. Skills associated with the platform

JourneyAX already has an on-demand skill mechanism: `apps/agent-commerce-service/skills/_platform/<name>/SKILL.md`
(every tenant) and `skills/<tenant>/<name>/SKILL.md`, loaded by the `loadSkill` tool, with a description that ends in
"Not needed when …" so the model can rule a skill out from its summary. In the target architecture skills are the
**technique** layer between the Journey Engine (what) and the model (how): a skill never carries facts, prices or
rules; it carries method.

### 6.1 Platform skills (Core, tenant-neutral)

| Skill | Used at pipeline stage | What it teaches the model |
|---|---|---|
| `interpret-goal` | 2 interpret | map a message to a generic goal + candidate facts, output the typed interpretation contract, never invent facts |
| `next-best-question` | 6 next decision → 10 phrase | phrase ONE question from `{fact, reason, options}`; explain why only when it changes options; no stacked questions |
| `explain-recommendation` | 10 phrase | one-sentence reason per item from capability facts; never list what the cards show |
| `compare-finalists` | 8/10 | build a comparison from structured specs; verdict in one line |
| `build-solution` | 8 build_solution | assemble a set/BOM only from relationships and calculators; refuse to pad |
| `ground-truth-language` | 10 phrase | distinguish inference from authoritative price/stock/compatibility/policy (CONV-006) |
| `summarise-project` | 11 render | produce the `ProjectSummary` payload: goal, stage, facts, decisions, open questions |
| `handoff-brief` | JE-009 | write the associate hand-over from the workspace, not from the transcript |
| `service-answer` | support journeys | answer from retrieved policy chunks only, then one door back into the journey |
| `search-discovery`, `purchase-research`, `planning-goals`, `customer-care`, `memory-personalization` | existing | keep; rewrite to reference workspace facts instead of chat history |

### 6.2 Pack skills (tenant-specific method, shipped in `business-pack/<tenant>/skills/`)

| Pack | Skills |
|---|---|
| Caroma | `plumbing-constraints` (set-out, waste, inlet before recommending), `fixture-compatibility`, `plumber-handoff` |
| PlaceMakers | `capacity-and-quantity` (m², lineal metres, pack rounding), `repair-before-replace`, `spec-to-product`, `branch-pickup`, `credit-returns` |
| Dragon Shield | `sleeve-finder` (size gate), `capacity-sizing`, `coordinated-set`, `gift`, `forge-handoff`, `support` (already on disk under `skills/dragonshield/`) |
| Augusta | `roster-to-order`, `design-brief-to-configurator` (from today's prompt code) |

Rules for skills: a skill may reference capabilities and required facts by name; it may not state a price, a
stock figure or a compatibility claim; every skill has at least one evaluation scenario that exercises it; skills
are versioned with the pack.

### 6.3 Engineering skill for this refactor

`.claude/skills/journeyax-refactor/SKILL.md` (added with this plan) encodes ADR-001 and §17.1 for anyone using an
AI coding assistant on the repo: no tenant words in Core, one pipeline, replace-not-delete for nudges, guards are
wrapped, run the tenant suite before publishing, config changes go through draft → publish.

---

## 7. Acceptance (from PRD §19) mapped to increments

| ID | Scenario | Passes after |
|---|---|---|
| A1 | remodel, insufficient facts → question before products | R3 |
| A2 | resume a week later, no re-asking | R4 |
| A3 | trade abbreviations resolved | R2 |
| A4 | project BOM through stages with calculators | R3 + R5 |
| A5 | account price from pricing capability only | R5 |
| A6 | missing stock → substitute path | R5 |
| A7 | same phrase, two tenants, no leakage | R2 |
| A8 | model change within tolerance | R6 |
| A9 | human handoff with full context | R4 |
| A10 | Studio change without deploy | R5 |

---

## 8. Open decisions to settle in week 1

1. Journey/rule format: JSON with zod schemas (recommended; Studio-editable) vs code-first DSL.
2. Pack inheritance: vertical pack → tenant overrides (recommended: shallow merge per file, arrays keyed by id).
3. Fact confidence and revalidation defaults: `customer`=0.9 stable, `inferred`=0.6 revalidate before-use, `capability`=1.0 with `validUntil`.
4. Mandatory capability classes for R5: `discover, recommend, price, check_availability, quote, order` first.
5. Configuration promotion: pack versions exported as JSON artifacts, promoted QA → prod by Studio publish.
6. Evaluation pass threshold: 100% of "must" scenarios, ≥ 90% of "should", release blocked otherwise.

---

## 9. What changes for each tenant on day one of R2

- **Dragon Shield:** guidance already loop-level; dimensions become required facts; the 12 scenarios become the suite. Little visible change.
- **PlaceMakers:** five journeys become stages with required facts (project, phase, room, size, sleeving analogue → dimensions); the deck/GIB calculators become `calculate`; branch stock becomes `check_availability` with the branch gate as a stage rule; returns become a `service` journey.
- **Caroma / Augusta:** the built-in question banks and garment logic leave Core and enter their packs; behaviour stays the same because the suite says so.
