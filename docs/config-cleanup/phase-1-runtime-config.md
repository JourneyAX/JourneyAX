# Phase 1 — Runtime configuration

## Goal

Make the agent consume published Back Office project configuration through one normalized runtime model instead of mixing tenant values, platform defaults, Brand Hub fallbacks, and hard-coded behavior in the service.

## Code added or changed

Location: apps/agent-commerce-service/src/runtime-config/

- defaults-platform.ts: platform-safe defaults for generic tenants.
- generic-business-config.ts: generic behavior defaults for incomplete tenants.
- schema/agent-config.ts: typed effective configuration shape.
- index.ts: runtime configuration exports.

The loader in src/pipeline/config-loader.ts now normalizes:

- tenant identity and company name;
- model, provider, temperature, and token settings;
- persona and journey guidance;
- business summary, audience, vocabulary, and entity model;
- context dimensions and scope;
- enabled capabilities and skills;
- commerce mode, pricing, purchase limits, fulfilment, and configurator flags;
- presentation labels and policies;
- retrieval policies;
- business rules and constraints.

## Prompt changes

Locations:

- src/prompts/base.ts
- src/prompts/business.ts
- src/prompts/technical.ts
- src/prompts/index.ts
- src/agent.service.ts

The platform prompt is domain-neutral. Tenant identity, business scope, journey guidance, vocabulary, rules, labels, approval behavior, commerce mode, and configured capabilities are injected from runtime configuration.

Platform safety and grounding rules remain code-owned because they are not tenant content.

## Behavior preserved

- Existing tenant persona and journey guidance remain available.
- Existing clarification and retrieval behavior remains intact.
- Product, pricing, and identifier grounding rules remain enforced.
- Configured business rules remain in model context.
- The same agent code serves different verticals without changing the platform prompt.

## Verification

- TypeScript build passes.
- Existing prompt and evaluation flows remain available.
- Configuration is loaded per published project rather than mutable request data.

## Boundary

Phase 1 established the configuration source. It did not move orchestration or tool execution.
