---
name: journeyax-refactor
description: Rules for changing JourneyAX while it moves from an LLM-led chatbot to a business-aware journey runtime (ADR-001). Use for any change under apps/agent-commerce-service, apps/project-service, apps/backoffice-admin or packages that touches journeys, prompts, tools, rules, tenant config or the turn pipeline. Not needed when editing storefront styling, a single card template, or a one-off data loader.
---

# JourneyAX refactor rules (ADR-001)

Read `docs/platform/journeyax-platform-refactor-plan.md` first. The PRD it companions is the source of the
requirement IDs used below.

## The decision you are working under

JourneyAX Core contains no industry-specific business logic. Tenant behaviour comes from a versioned Business
Pack. The Journey Engine owns process state and the next decision. Enterprise services own business truth. The
LLM owns language understanding and phrasing, and is never the source of a fact, a price, a compatibility claim
or a stage transition.

## Before you write code

1. Name the layer the change belongs to: Business Pack · Journey Engine · Context Engine · Capability Runtime ·
   Go · Studio · Core pipeline. If it is "the prompt", stop and find the layer it really belongs to.
2. If the change is tenant- or vertical-specific (a word like bathroom, GIB, jersey, sleeve; a branch name; a
   question bank; a product rule), it goes into that tenant's pack or config, never into shared code (CORE-001).
3. If you are about to add a per-turn `[SOMETHING ASK]` system nudge, don't. Express it as a stage's required
   fact, an allowed/blocked capability, a rule, or a conversation-policy line (PRD §17.1).
4. If the same logic exists in more than one turn path, fix it in the shared stage function; until R1 lands,
   apply the fix at every dispatch site and say so in the commit message.

## While you write code

- Keep deterministic guards authoritative and wrap them: bag commands, pricebook grounding, sold-out and
  purchase-limit refusal, bundle facts, dimension hard filters, exact-code lookup. Never let a model result
  bypass one (CAP-004).
- A tool result to the model must directly follow the tool call in the conversation; put system notes after it.
- Facts the model extracts are candidates; facts from capabilities are authoritative. Persist facts with source,
  confidence and capturedAt (PM-002).
- New config fields need: project-service type + `updateProject` whitelist, agent config-loader mapping, back-office
  type, and a draft → publish step to go live (PATCH lands in draft only).
- Rebuild `packages/ui-cards` with `npx tsc` after editing its `src`; the storefront resolves `dist/`.
- Repo is TypeScript-only; one-off loaders stay in the scratchpad.

## Before you finish

- Run the tenant suite for every tenant you touched: `pnpm eval --tenant <id>` once R0 exists; until then the
  scratchpad scenario runner. A behaviour change without a scenario is not done.
- `npx tsc --noEmit` in every touched app or package.
- Commit with a message that names the layer and the requirement IDs; end with the co-author line the session
  specifies. Never push unless asked.
- Config that must go live: publish it, then confirm `activeVersion` moved.

## Smells that mean you are drifting back to the chatbot

- A regex over the model's prose to recover a decision.
- A tenant's product name or category in `agent.service.ts`.
- The model choosing the journey stage or the next question without the engine's required-facts list.
- A card rendered from model-authored prices, images or stock.
- A "safety net" that turns any question mark into chips.
