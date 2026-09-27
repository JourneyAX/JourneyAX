# Phase 3 — Tool architecture and executor extraction

## Goal

Separate tool schemas and business execution from AgentService without changing tool names, arguments, results, UI actions, or external service behavior.

## New tool structure

~~~text
src/tools/
  contracts.ts
  generic-tools.ts
  tenant-tools.ts
  registry.ts
  policy.ts
  executors/
    retrieval.ts
    presentation.ts
    commerce.ts
    customisation.ts
    support.ts
    team.ts
~~~

## Definitions and policy

- contracts.ts contains shared tool-name and contract types.
- generic-tools.ts contains domain-neutral schemas and descriptions.
- tenant-tools.ts contains contracts dependent on tenant capabilities.
- registry.ts maps capabilities to available tools and identifies UI tools.
- policy.ts builds the active toolset for the tenant and turn.

## Executor migrations

### retrieval.ts

Product option lookup, related-item lookup, and product-name-to-SKU resolution.

### presentation.ts

Catalogue matching, item fact grounding, empty presentation verdicts, and bundle refusal verdicts.

### commerce.ts

Sizing, storage, demo customer order/offer/inventory tools, quote SKU resolution, authoritative quote construction, deterministic storefront cart mutations, and order-placed handling.

The quote builder is shared by buffered and streaming paths, so both use the same server-authoritative pricing and SKU resolution.

### customisation.ts

Designable alternative lookup, configurator validation, design analysis, generated design, team design generation, photo upload, artwork handling, review submission/status, and team-order submission.

### support.ts

Project plans, branch stock, and entity persistence.

### team.ts

Team-programme colour lookup, roster parsing, entity lookup, and SKU existence validation.

## AgentService integration

AgentService remains responsible for parsing model tool calls, deciding retries, inserting tool results in conversation order, updating journey state, persisting session steps, and emitting buffered or streaming UI actions.

Executors receive explicit tenant, session, configuration, service, and callback context. This keeps side effects visible and avoids hidden global state.

## Behavior preserved

- Existing tool names and argument contracts.
- Existing product-service and commerce-service endpoints.
- Existing timeouts and error responses.
- Server-authoritative prices and totals.
- Purchase limits and sold-out behavior.
- UI-action payloads and journey-state updates.
- Buffered and streaming execution parity.

## Verification

- npm run build --workspace=agent-commerce-service
- git diff --check
- No duplicate local executor functions.
- No legacy executor wrappers retained.

## Boundary

AgentService still contains orchestration guards around updateQuote, retrieval, presentation, retries, and state persistence. These are not executor logic and should move only with ordering and side-effect tests.
