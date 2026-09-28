# Commerce Agent Configuration and Tool Architecture

## Purpose

This document explains the implementation completed in the commerce agent cleanup. It is intended to be shared with engineering, platform, and Back Office stakeholders who need to understand what changed, what remains code-owned, and how the agent remains compatible with existing tenants and storefront clients.

The migration has two related goals:

1. Make published Back Office configuration the source of tenant and business behavior wherever an existing configuration field already supports that behavior.
2. Separate tool contracts, capability policy, and tool execution from the central `AgentService` without changing the public tool protocol or storefront payloads.

No new Back Office fields were introduced by this work. The implementation normalizes and uses fields that already exist, with platform-safe fallbacks where a published project is incomplete.

## Scope and outcome

The effective runtime path is now:

```text
Published Back Office project
          |
          v
  config-loader.ts
          |
          v
  EffectiveAgentConfig
          |
   +------+-------------------+
   |                          |
   v                          v
Prompt/runtime context   Capability/tool policy
                              |
                              v
                   Model-visible tool definitions
                              |
                              v
                   Extracted tool executors
                              |
                              v
                         AgentService
                 (turn orchestration and persistence)
```

The agent still supports both buffered and streaming execution. Existing tool names, arguments, results, UI actions, quote behavior, purchase limits, and service integrations remain the compatibility boundary.

## 1. Effective runtime configuration schema

The canonical type is `EffectiveAgentConfig` in:

`apps/agent-commerce-service/src/runtime-config/schema/agent-config.ts`

It is a normalized, agent-facing view of the published project. It is not a copy of the entire Back Office database record.

### Top-level schema

```ts
interface EffectiveAgentConfig {
  tenant: AgentTenantConfig;
  ai: AgentAiConfig;
  persona: AgentPersonaConfig;
  scope: AgentScopeConfig;
  behavior: AgentBehaviorConfig;
  capabilities: AgentCapabilityConfig;
  skills: AgentSkillConfig[];
  commerce: AgentCommerceConfig;
  integrations: AgentIntegrationConfig;
  presentation: AgentPresentationConfig;
  retrieval: AgentRetrievalConfig;
  intents: AgentIntentConfig;
  journeys: AgentJourneyConfig;
  stages: AgentStageConfig;
  rules: AgentRulesConfig;
  runtimeContext?: RuntimeContext;
}
```

Back Office blocks that belong to another subsystem are retained as typed escape hatches or metadata, but are not silently treated as agent instructions:

```ts
console;
notifications;
embed;
channels;
knowledgeSource;
theme;
components;
multiTradeBundles;
scenarios;
intro;
```

This boundary prevents admin navigation, storefront theme settings, test scenarios, or integration secrets from entering the reasoning prompt accidentally.

### Tenant and AI settings

```ts
interface AgentTenantConfig {
  projectId: string;
  name?: string;
  companyName?: string;
  formerNames?: string[];
  configVersion?: number;
  source: 'backoffice' | 'platform-default' | 'fallback';
}

interface AgentAiConfig {
  provider?: string;
  model?: string;
  intentModel?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}
```

`baseUrl` and integration credentials are runtime-only. Secrets are not prompt content and must not be written to traces.

### Persona, scope, and behavior

```ts
interface AgentPersonaConfig {
  systemName?: string;
  systemPromptOverrides?: string;
  journeyGuidance?: string;
  greetingMessage?: string;
  journeyGraph?: { nodes: any[]; edges: any[] };
}

interface AgentScopeConfig {
  rooms?: string[];
  categories?: string[];
  business?: any;
  dimensions: AgentContextDimensions;
}
```

Behavior is represented as policy rather than embedded prose alone:

```ts
interface AgentBehaviorConfig {
  personaBehavior: {
    tone: string;
    expertise: string;
    supportiveMessage: string;
  };
  conversationExperience: {
    reclassifyGoalEachTurn: boolean;
    preserveLatestCustomerGoal: boolean;
    clarifyOnlyMissingContext: boolean;
    avoidRepeatingCompletedQuestions: boolean;
  };
  terminology: {
    genericConceptDefinitions: boolean;
    explainUnknownTerms: boolean;
    neverInferTenantTerms: boolean;
  };
  vocabulary: {
    concepts?: Record<string, string>;
    synonyms?: Record<string, string[]>;
    jargon?: Record<string, string>;
    glossary?: Record<string, string>;
  };
  conversationPolicy: {
    reclassifyGoalEachTurn: boolean;
    preserveLatestCustomerGoal: boolean;
    intentPrecedence: string[];
  };
  recommendationPolicy: {
    requireVerifiedMatch: boolean;
    explainWhyItMatches: boolean;
    distinguishAlternativesFromComplements: boolean;
    neverInventRelationships: boolean;
  };
  supportPolicy: {
    answerFromConfiguredSources: boolean;
    discloseMissingCoverage: boolean;
    handoffWhenActionUnavailable: boolean;
  };
  retrievalPolicy: {
    focusedQueries: boolean;
    queryWordRange?: { min: number; max: number };
    maxSearchCallsPerTurn: number;
    skipDuringDiscovery: boolean;
  };
  presentationPolicy: {
    preserveRetrievedValues: boolean;
    doNotInventIdentifiers: boolean;
    doNotInventPrices: boolean;
    useConfiguredPresentationSurface: boolean;
  };
  organizationResearch: {
    enabled: boolean;
    confirmDetailsBeforeUsing: boolean;
  };
}
```

### Capabilities, commerce, presentation, and retrieval

```ts
interface AgentCapabilityConfig {
  enabled: string[];
}

interface AgentCommerceConfig {
  mode: 'cart' | 'quote' | 'disabled';
  pricing?: {
    currency: string;
    symbol: string;
    taxRate: number;
    discountRate: number;
  };
  canQuotePrices: boolean;
  canPlaceOrders: boolean;
  fulfilment?: any;
  handoffs?: any[];
  purchaseLimits?: any[];
  storageGuide?: any[];
  demoCustomers?: any;
  configuratorType?: string;
  sizeScale?: string[];
}
```

The presentation block controls labels, card templates, quote copy, and value-validation policy. The retrieval block controls the selected collection, result count, minimum score, allowed types, intent policies, query limits, and discovery suppression.

The loader also normalizes business rules and constraints into:

```ts
interface AgentRulesConfig {
  business: Array<{
    id?: string;
    name?: string;
    scope?: string;
    condition?: string;
    action?: string;
    description?: string;
  }>;
  constraints: {
    canQuotePrices?: boolean;
    canPlaceOrders?: boolean;
    restrictedTerms?: string[];
    [key: string]: unknown;
  };
  communication?: Record<string, unknown>;
}
```

## 2. Configuration loading and precedence

`src/pipeline/config-loader.ts` creates the effective runtime configuration once the published project has been loaded. The loader normalizes tenant identity, AI settings, persona, business scope, vocabulary, capabilities, skills, commerce mode, pricing, fulfilment, presentation, retrieval, and business rules.

The precedence rules are deliberate:

1. An explicitly configured Back Office value wins.
2. A legacy Brand Hub value is used only when the Back Office field is absent.
3. A generic platform fallback is used when neither source provides a value.

This is especially important for customisation. A stale Brand Hub value cannot override a deliberate Back Office decision.

The generic defaults are in:

```text
src/runtime-config/defaults-platform.ts
src/runtime-config/generic-business-config.ts
```

These defaults are platform behavior, not tenant-specific product or business content.

## 3. Prompt and policy separation

Prompt construction now receives the normalized runtime context. Tenant-controlled content includes persona, company identity, journey guidance, business scope, terminology, configured rules, labels, commerce mode, and enabled capabilities.

Code-owned safety and grounding rules remain in the platform prompt and runtime guards. These include:

- never inventing SKUs, prices, product facts, or catalogue relationships;
- using retrieved catalogue values as the authority;
- preserving identifiers and prices returned by services;
- not claiming a design is production-ready before approval;
- not emitting an empty quote;
- using the configured presentation surface;
- respecting tenant and customer identity boundaries;
- failing closed when configuration or validation is unavailable.

This prevents business copy from being hard-coded while retaining platform invariants that protect every tenant.

## 4. Tool architecture

The tool layer is now organized under:

```text
apps/agent-commerce-service/src/tools/
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
```

### Contracts

`contracts.ts` contains shared OpenAI tool types and the request shape used to construct a toolset:

```ts
interface ToolsetRequest {
  enabledCapabilities?: string[];
  entityModel?: { label?: string; labelPlural?: string };
  closing?: 'bag' | 'quote';
}
```

It also defines the universal and UI tool-name sets used by policy and orchestration.

### Generic definitions

`generic-tools.ts` contains reusable schemas and descriptions for platform primitives such as:

- knowledge retrieval and related-item lookup;
- product options and identifier resolution;
- phase and clarification presentation;
- product cards, comparisons, bundles, add-ons, guides, documents, and information panels;
- choices, suggestions, skills, and general project support.

These schemas are tenant-neutral. They describe the contract and validation requirements; tenant content comes from retrieval and runtime configuration.

### Tenant-dependent definitions

`tenant-tools.ts` contains schemas whose availability or arguments depend on configured tenant capabilities or a tenant integration, including commerce, custom design, team programmes, customer history, roster, stock, and configurable presentation operations.

Separating the definitions does not remove those capabilities. It makes the dependency explicit so the policy layer can include only what the published project enables.

## 5. Capability-to-tool policy

`registry.ts` maps Back Office capability IDs to model-visible tools.

| Capability | Tools enabled |
|---|---|
| `products` | `showItems`, `presentComparison`, `presentBundle`, `recommendStorage` |
| `customerHistory` | `getMyOrders`, `getMyLatestOrder`, `getMyOrder`, `getCurrentOffer`, `getStaffInventory` |
| `steps` | `showGuide` |
| `quote` | `updateQuote` |
| `accessories` | `showAddons` |
| `choice` | `presentChoice` |
| `installGuide` | `showDocuments` |
| `warranty` | `showInfo` |
| `configurator` | `showConfigurator` |
| `roster` | `readRoster` |
| `teamColours` | `getTeamColours` |
| `customDesign` | `analyzeDesign`, `generateDesign`, `showConfigurator`, `submitForReview`, `checkReviewStatus` |
| `teamOrder` | `generateTeamDesign`, `submitTeamOrder` |
| `photoUpload3D` | `uploadPhotosFor3D` |
| `fitmentGuide` | `recommendSize` |

Universal tools are safe platform primitives and remain available. When a project has a non-empty capability list, `policy.ts` filters the complete definition list to universal tools plus the mapped capabilities. When no capability list exists, the existing all-tools fallback is retained for compatibility with older/incomplete projects.

The policy also:

- adds `updateQuote` for cart/bag closing;
- substitutes the configured entity label and plural label into tool descriptions;
- changes the cart `updateQuote` contract to support `items` and `remove` while preserving the existing quote contract;
- keeps tool order stable for model behavior and evaluations.

## 6. Executor responsibilities

Executors receive explicit context rather than reading hidden global state. They retain service calls, validation, result shaping, and side effects; `AgentService` remains responsible for when and in what order they run.

### `retrieval.ts`

Owns product option lookup, related-item lookup, and product-name-to-SKU resolution. It preserves retrieval context and catalogue provenance requirements.

### `presentation.ts`

Owns catalogue matching, item fact grounding, empty-presentation verdicts, and bundle-refusal verdicts. It prevents model-provided values from replacing values already retrieved from the catalogue.

### `commerce.ts`

Owns:

- sizing and storage recommendations;
- demo customer order, offer, and inventory tools;
- quote item SKU resolution;
- server-authoritative quote construction;
- deterministic storefront cart mutations;
- order-placed context handling.

`buildAuthoritativeQuote` is shared by buffered and streaming paths. Cart commands and order context are also applied through shared functions, preventing the two execution modes from drifting.

### `customisation.ts`

Owns designable alternatives, configurator validation, design analysis, generated designs, team-design generation, photo upload, artwork handling, review submission/status, and team-order submission.

### `support.ts`

Owns project-plan generation, branch-stock lookup, and entity persistence.

### `team.ts`

Owns team-programme colour lookup, roster parsing, entity lookup, and SKU-existence validation.

## 7. AgentService boundary

`AgentService` is intentionally not empty. It is the orchestration façade and still owns:

- model-loop control and retry limits;
- parsing model tool calls;
- dispatching tools in conversation order;
- inserting tool results into the model conversation;
- retrieval, presentation, and commerce safety gates;
- journey-state reduction;
- session-step persistence;
- buffered and streaming response finalization;
- UI-action ordering and emission.

The extraction removed duplicate executor implementations, not the lifecycle decisions that coordinate them. Moving those decisions requires ordering and side-effect tests because a seemingly mechanical move can change streaming parity, retry behavior, journey writes, or UI timing.

## 8. End-to-end turn behavior

For a normal turn, the lifecycle is:

1. Load the published project and construct `EffectiveAgentConfig`.
2. Build prompt context from tenant configuration and code-owned safety rules.
3. Build the active model toolset from capabilities, entity labels, and commerce closing mode.
4. Ask the model for a response and optional tool calls.
5. Validate tool availability and required arguments.
6. Dispatch to the matching extracted executor.
7. Apply server-side grounding, pricing, stock, quantity, and capability guards.
8. Insert tool results in the original model-call order.
9. Reduce journey state and persist session changes exactly once.
10. Emit buffered or streaming text and UI actions using the existing contracts.

The streaming path uses the same commerce quote/cart/order functions as the buffered path. This is a key compatibility guarantee.

## 9. Safety and compatibility guarantees

The migration preserves the following behavior:

- existing tool names and argument/result shapes;
- existing product, commerce, quote, order, and configurator service endpoints;
- server-authoritative prices, totals, SKUs, stock, and purchase limits;
- sold-out and quantity validation behavior;
- UI-action payloads consumed by the storefront;
- tenant-scoped retrieval and integration selection;
- buffered/streaming response parity;
- fallback behavior for projects without a complete capability list.

The migration does not make these assumptions:

- that all Back Office records are agent instructions;
- that a Brand Hub value should override an explicit Back Office value;
- that every tenant supports configurator, cart, quote, team order, or customer history;
- that a model-supplied product fact is trustworthy without retrieval provenance.

## 10. Verification performed

The service build was run successfully:

```text
npm run build --workspace=agent-commerce-service
```

Repository whitespace validation was also run:

```text
git diff --check
```

The source was reviewed for duplicate local executor implementations and legacy executor wrappers. The current architecture has one extracted implementation per migrated executor group.

## 11. Remaining work

The next safe phase is orchestration extraction. The proposed modules are:

```text
src/orchestration/
  turn-context.ts
  turn-runner.ts
  tool-dispatcher.ts
  guards/
    retrieval-guards.ts
    commerce-guards.ts
    presentation-guards.ts
  state/
    journey-updater.ts
    session-persistence.ts
  responses/
    response-finalizer.ts
    streaming-finalizer.ts
```

The extraction should proceed in small, testable steps:

1. Introduce an immutable turn context.
2. Move pure validation and guard functions.
3. Move shared parsing and dispatch.
4. Move quote/cart/order orchestration around the existing executors.
5. Move journey-state reduction and persistence.
6. Move buffered and streaming runners onto one lifecycle.
7. Leave `AgentService` as the controller façade.

Required checks for that phase are TypeScript build, diff validation, quote/cart/order tests, buffered-versus-streaming parity tests, UI-action contract checks, and journey-state persistence checks. No new Back Office schema should be added merely to support this extraction.

## Related documents

- [Configuration cleanup overview](README.md)
- [Phase 1 — Runtime configuration](phase-1-runtime-config.md)
- [Phase 2 — Configuration safety](phase-2-config-safety.md)
- [Phase 3 — Tool architecture](phase-3-tool-architecture.md)
- [Next phase — Orchestration extraction](next-orchestration.md)
