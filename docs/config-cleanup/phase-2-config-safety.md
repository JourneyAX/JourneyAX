# Phase 2 — Configuration safety and capability gating

## Goal

Ensure Back Office configuration is authoritative and disabled or invalid capabilities cannot leak into the model toolset or UI actions.

## Back Office precedence

Customisation resolution now follows this order:

1. use Back Office business.customised when explicitly configured;
2. use Brand Hub only when the Back Office value is absent;
3. use the generic fallback when neither source is available.

This prevents an old Brand Hub value from overriding a deliberate Back Office setting.

## Configurator gating

The configurator is available only when all conditions are true:

- customisation is enabled for the business;
- configurator.enabled is explicitly true;
- configured capabilities include configurator.

If any condition fails, the configurator tool is removed from the active toolset.

## Required UI-tool enforcement

The UI enforcement path now checks the active tool policy before forcing a UI tool, does not force an unavailable configurator, fails closed when validation or configuration loading fails, and avoids emitting a UI action that the storefront cannot render.

## Related code

- src/tools/policy.ts: active capability and tool filtering.
- src/tools/registry.ts: UI tool names and capability mapping.
- src/pipeline/config-loader.ts: configurator configuration loading.
- src/agent.service.ts: customisation availability and required UI-tool checks.

## Prompt rule preservation

Generic rules remain code-owned:

- do not invent SKU, price, or product facts;
- use verified catalogue data;
- do not claim a design is production-ready without approval;
- do not emit an empty quote;
- use the configured UI surface;
- protect tenant and customer identity boundaries.

Tenant wording is replaced only when an existing Back Office field can provide it.

## Verification

- Build passes with configurator enabled and disabled paths.
- Active tool filtering is configuration-aware.
- Required UI-tool validation fails closed.
- No legacy capability-registry implementation remains.
