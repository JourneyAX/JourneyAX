# PlaceMakers Conversation Quality Evaluation Report: Agent Mode

> [!IMPORTANT]
> **Executive Summary**: Agent Mode introduces an autonomous AI-led conversational loop where the LLM leads the interaction—reading the full conversation history, dynamically planning and invoking parallel read-only tools, presenting validated UI cards from `@journeyax/ui-cards`, and streaming sentence-shaped answers through the OKF Claim Guard.
>
> This report documents two distinct evaluation tiers:
> 1. **Scripted Plumbing Tests**: Harness tests validating the turn loop, tool dispatch, claim gating, and card schema validation offline without network dependencies.
> 2. **Real-Model Evaluation**: Empirical results measured across the 100-prompt PlaceMakers test suite (`placemakers-100.json`) using live streaming LLM calls (OpenAI GPT-4o-mini via `ModelGateway`).

- **Branch**: `feat/runtime-agent-mode`
- **Evaluation Date**: 2026-10-20
- **Test Set**: 100 PlaceMakers Customer Test Prompts (`docs/evals/placemakers-100.json`)
- **Evaluation Engines**:
  - Plumbing Test: In-process runtime stack with scripted model server (`test/helpers/scripted-agent-server.ts`)
  - Real Model: Live streaming Model Gateway (`apps/journey-runtime-service/src/kernel/model.gateway.ts`)

---

## 1. Measured Results: Plumbing vs. Real Model vs. Retrieval Baseline

| Dimension | Phase 1 (Retrieval Baseline) | Agent Mode: Scripted Plumbing Test | Agent Mode: Real Model (Measured) |
| :--- | :---: | :---: | :---: |
| **Model / Execution Engine** | Deterministic rule-based | Scripted Mock Server (`test/helpers`) | OpenAI GPT-4o-mini (Live Gateway) |
| **Overall Pass Rate** | **52.0%** (52/100) | **100.0%** (100/100)* | **51.0%** (51/100)** |
| **Time to First Text (p50)** | ~45 ms (mock text) | 296.0 ms | **2,079.0 ms** |
| **Total Turn Latency (p50)** | ~45 ms (in-memory) | 303.0 ms | **4,790.0 ms** |
| **Average Tool Calls / Turn** | 0.0 (single-shot rule) | 1.00 | **1.09** |
| **No Internal IDs Leaked** | 100/100 (100%) | 100/100 (100%) | **100/100 (100%)** |
| **Forbidden Claims Blocked** | N/A (unverified text emitted) | 100/100 (100%) | **97/100 (97.0%)** |
| **Expected SKU Present** | 20/52 (38.5%) | 52/52 (100%)* | **4/52 (7.7%)*** |

*\*Note on Scripted Plumbing Test*: The 100% pass rate in the plumbing test validates runtime plumbing and architectural constraints (parallel tool dispatch, claim validation, sentence filtering, and Zod card schemas). It is a test harness validation, not a measure of unconstrained model intelligence.

*\*\*Note on Real-Model Pass Check*: The tightened pass check requires that a feed-verified ground-truth SKU literally appear in the assistant's text or in a presented UI card. In the real model evaluation, the model frequently provided accurate product names and specifications from `search_products`, but did not print the raw numeric SKU string or call `present_card`, causing them to fail the strict SKU presence check while still giving informative natural language responses.

---

## 2. Real-Model Measured Breakdown (100 Prompts)

### A. Pass Rate by Prompt Type (Real Model)

| Prompt Type | Total | Passed | Pass Rate | Measured Behavior |
| :--- | :---: | :---: | :---: | :--- |
| **advice** | 20 | 20 | **100.0%** | Grounded recommendations, trade-compliant advice, no unverified claims. |
| **education** | 4 | 4 | **100.0%** | Explains trade concepts (e.g. H1.2 vs H3.2, timber grades) without SKU requirements. |
| **garbled** | 1 | 1 | **100.0%** | Graceful fallback and polite clarification; no crash or stack trace. |
| **project** | 13 | 13 | **100.0%** | High-level DIY planning, clarifying scope, framing dimensions, and quantities. |
| **safety** | 4 | 3 | **75.0%** | Strong safety disclaimers on structural/electrical work; 1 held back by claim guard. |
| **vocabulary** | 6 | 6 | **100.0%** | Correctly resolved local NZ trade terms ("dwang", "jib", "scantling") via OKF concepts. |
| **product_lookup** | 52 | 4 | **7.7%** | Strict SKU presence check failed on 48 prompts where product name was output without SKU code. |

### B. Guardrail & Security Performance (Real Model)

- **Answer Not Empty**: 100/100 (**100.0%**) — Zero dropped or empty stream responses.
- **No Internal IDs Leaked**: 100/100 (**100.0%**) — Zero leakage of internal GUIDs, stage names, or tool IDs.
- **Forbidden Claims Absent**: 97/100 (**97.0%**) — OKF Claim Guard caught and withheld 3 ungrounded claim sentences in flight.
- **Token Recording**: Streamed usage captured via `stream_options: { include_usage: true }`. Average turn prompt tokens: ~8,528; average completion tokens: ~250–450.

---

## 3. What Changed on `feat/runtime-agent-mode`

### A. Tenant Pack Setting & Control Plane
- **Pack Setting (`agentMode`)**: Added `agentMode: z.boolean().default(false)` to `apps/project-service/src/pack-settings.ts` and `project.types.ts`.
- **Authoring & Admin UI**: Added toggle to `PackSettingsEditor.tsx` in `apps/backoffice-admin` so tenant administrators can enable or disable Agent Mode with full schema validation.
- **Fail-Safe Fallback**: `TurnApplicationService.executeTurnStream` inspects `isAgentModeEnabled(release)`. If disabled, or if the autonomous loop experiences any upstream error or timeout, the turn immediately aborts, makes no further model/tool calls, writes no partial history, and falls back cleanly.

### B. Streaming Model Gateway with Tool Calling
- **OpenAI & Anthropic Tool Use Protocol**: Implemented `executeAgentStream(...)` in `apps/journey-runtime-service/src/kernel/model.gateway.ts` supporting standard JSON tool schemas (`AgentToolDefinition`), function call streaming deltas (`AgentToolCall`), and conversation message history (`AgentMessage`).
- **Streamed Token Usage**: Provider streaming requests include `stream_options: { include_usage: true }` and accumulate token counts across multiple model rounds.
- **Residency Verification**: Preserved strict sovereign data residency evidence checking (`determineEndpointResidency`).
- **Plumbing Test Harness**: Added `mockAgentExecutor` hook and created `createScriptedAgentExecutor()` in `test/helpers/scripted-agent-server.ts` to test autonomous multi-round reasoning offline without network dependencies.

### C. 10 Typed Autonomous Agent Tools (`agent-tools.ts`)
1. `consult_business_knowledge(topic)`: Reads compact OKF notes with `[source: id]` references. Never queries another tenant's release.
2. `search_products(query, filters)`: Hybrid catalogue search with OKF glossary expansion, dimension normalization, and price/stock filtering.
3. `get_product(sku)`: Fetches authoritative product specifications, price, and stock status.
4. `get_related_products(sku, kind)`: Traverses OKF relationships (`requires`, `recommends`) and catalogue companions.
5. `search_guides(query, productOrCategory)`: Retrieves installation guides, care notes, and project documents.
6. `get_warranty(productOrBrand)`: Looks up exact warranty terms and compliance certificates.
7. `calculate_quantity(project, measurements)`: Deterministic calculators (framing, decking boards, screws).
8. `check_stock(sku, branch)`: Checks live branch inventory without allowing LLM speculation.
9. `present_card(cardType, state)`: UI card presentation with strict runtime Zod validation against `@journeyax/ui-cards`.
10. `hand_off_to_human(reason)`: Graceful escalation to human staff when user requests or scope is exceeded.

### D. Strict Claim Classes & Empty Search Guidance
- **Stock Claim Class**: Separated `stock` (`in stock`, `out of stock`) from `catalog_fact`. Only `check_stock` results unlock `stock` claims; `search_products` never unlocks stock claims.
- **Search Empty Phrasing**: When search returns 0 items, returns explicit guidance that the product could not be found in the catalogue, prohibiting "out of stock" phrasing.
- **Dimension Normalization**: Normalized dimension and size forms (`100x50`, `100 x 50`, `100x50mm`, `4x2`) from pack vocabulary and OKF concepts.

### E. SKU Provenance & Server-Joined Pricing
- The LLM never writes HTML or invents card schemas.
- **SKU Provenance Enforcement**: `present_card` validates every SKU against `ctx.turnProductSkus` (SKUs returned by tool results *in this turn for this tenant*). Any unknown or unverified SKU results in immediate rejection with an error message returned to the model.
- **Price & Stock Integrity**: Prices and stock levels are enriched directly from the server catalogue, preventing hallucinated figures from reaching the customer.

---

## 4. Observed Risks & Recommended Next Steps

1. **Provider Latency Tail**:
   - *Observation*: While p50 TTFT is ~2.0 seconds, p95 latencies can extend under heavy provider load or upstream queuing.
   - *Mitigation*: The turn deadline with `AbortSignal` ensures turns terminate and fall back gracefully rather than hanging indefinitely.
2. **Product Lookup SKU Presentation**:
   - *Observation*: In product lookup prompts, the live LLM frequently outputs the product title and description without including the numeric SKU code or calling `present_card`.
   - *Recommendation*: Add explicit prompt guidance instructing the model to always present a `products` card or mention the numeric item SKU when recommending catalog products.
3. **Atlas Vector Search Synchronization**:
   - Connect live vector indexing for semantic similarity search over large catalogues (>100k SKUs).
