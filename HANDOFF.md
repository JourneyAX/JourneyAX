# JourneyAX Inter-Agent Handoff Log

This document records cross-agent interface agreements and schema contracts between the 4 remediation agents.

---

## Agent 1 (Security & Routing) -> Agent 2 (Durable Runtime & Journey Engine)

1. **Interpreter Failures in Turn Trace**:
   - `TurnInterpreter.interpret(...)` now returns `InterpretationResult.failure?: { type: string, provider?: string, message: string }` instead of silently swallowing model gateway errors.
   - **Action for Agent 2**: In `apps/journey-runtime-service/src/kernel/turn-application.service.ts`, check `interpretation.failure` and append it to `trace.errors` or `trace.events` so the turn trace reflects any upstream model gateway failure truthfully.

2. **Capability-Sourced & Confirmation Facts**:
   - Free text customer input can no longer assert facts marked `source: 'capability'` or confirmation facts (`bom_confirmed`, `quote_generated`, `package_selected`, `order_submitted`, `order_created`, `payment_confirmed`, `quote_finalized`).
   - **Action for Agent 2**: Ensure `outputFactMapping` on tool bindings applies after a successful validated outcome with `source: 'capability'` and `confidence: 1.0` so stage exit conditions requiring these facts can be satisfied.

3. **Undeclared Fact Dropping**:
   - The interpreter now drops any candidate facts whose keys are not declared in `requiredFacts`, `optionalFacts`, `slotQuestions`, `slotSynonyms`, or entity definitions.
   - **Action for Agent 2 / Agent 3**: Ensure all facts needed by stages or capabilities are declared in the journey stages or vocabulary.

---

## Agent 1 (Security & Routing) -> Agent 3 (Business Packs & Studio)

1. **Evidenced Data Residency Declarations**:
   - `packages/business-pack/src/schemas/model-policy.schema.ts` now accepts `acceptedResidencies: string[]` and `residencyAttestation?: ResidencyAttestationSchema`.
   - `packs/placemakers/model-policy.json` has been updated with:
     ```json
     "acceptedResidencies": ["nz", "au", "us"],
     "residencyAttestation": {
       "attestationType": "cross_border_cloud_processing_agreement",
       "legalEntity": "Fletcher Building Limited (NZ)",
       "processingCountries": ["nz", "au", "us"],
       "lastReviewed": "2026-09-28"
     }
     ```
   - Documentation of the Fletcher Building NZ cross-border cloud processing assumption is documented in `packs/placemakers/README.md`.

---

## Agent 2 (Durable Runtime & Journey Engine) -> Agent 3 (Business Packs & Studio)

1. **Declarative Stage Capability Planning (`capabilityPlan`)**:
   - `packages/journey-core/src/types.ts` and `packages/business-pack/src/schemas/journey.schema.ts` now support `capabilityPlan` on each `JourneyStage`:
     ```json
     "capabilityPlan": [
       {
         "toolId": "catalog.search",
         "when": {
           "factsMissing": ["catalog_items"],
           "factsPresent": ["deck_dimensions"]
         },
         "producesFacts": ["catalog_items"]
       },
       {
         "toolId": "trade.quote_create",
         "when": {
           "factsPresent": ["catalog_items"],
           "factsMissing": ["quote_generated"]
         },
         "producesFacts": ["quote_generated", "bom_confirmed"]
       }
     ]
     ```
   - Evaluation: Items are evaluated in array order. The first item whose `when` condition passes and whose `producesFacts` are not yet all present in `workspace.facts` is chosen for invocation.
   - Fallback: If no `capabilityPlan` is declared, `allowedCapabilities` is evaluated sequentially, checking whether a capability's mapped output facts are already present before selecting the next capability.

2. **Output-to-Fact Mapping (`outputFactMapping`) on Tool Bindings**:
   - Tool bindings (in `capabilities.toolBindings` or within `stageBindings[].tools[]`) now support `outputFactMapping: Record<string, string>`:
     ```json
     {
       "toolId": "trade.quote_create",
       "outputFactMapping": {
         "quote_generated": "quoteId",
         "bom_confirmed": "confirmed"
       }
     }
     ```
   - Values are JSON paths (e.g. `'quoteId'`, `'items.0.sku'`, `'summary.total'`).
   - When the capability completes successfully and passes validation, `TurnApplicationService` extracts each path from the capability outcome, asserting it into `workspace.facts` with `source: 'capability'` and `confidence: 1.0`.

3. **Stage Rules and `appliesTo`**:
   - `validate-outcome.ts` now evaluates rules filtered strictly by `appliesTo { toolIds, stageIds, journeyIds }`.
   - Supported actions: `deny`, `require_approval`, `warn`.
   - Strict equality operators `===` and `!==` are now fully supported in rule expressions.
   - The hardcoded 'budget' fact key has been removed from core. Packs should declare budget compliance as a pack rule using `appliesTo`.

4. **Journey Matching & Fallbacks**:
   - Matching is strictly based on pack-declared `triggerIntents`, `goals`, `displayName`, and interpreted intent. Capability name fuzzing and 4-char prefix heuristics have been completely removed.
   - Greetings ("hi", "hello", etc.) or unrecognised requests trigger pack-declared welcome decisions or fail closed, rather than technical internal handoff messages.

