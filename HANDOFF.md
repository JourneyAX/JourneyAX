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

*(To be filled during Agent 2 execution)*
- `capabilityPlan` schema contract on stage definition.
- `outputFactMapping` schema contract on tool binding.
