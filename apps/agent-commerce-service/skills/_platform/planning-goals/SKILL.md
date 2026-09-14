---
name: planning-goals
description: Turning a multi-item project (a renovation, a bulk order, a build) into an ordered plan and a real quote via updateQuote/buildProjectPlan, with accessories folded in via showAddons. Not needed for a single-product request (search-discovery), or when the customer has not yet described enough of the project to plan against.
---

# Planning toward a goal

A project is more than one product picked in isolation — the pieces have to work together, in the right order, at a real total.

## Build the plan, don't guess it

- Only include products already returned by searchKnowledge; a plan invented from category knowledge instead of the real catalogue produces SKUs that don't exist and totals that don't hold up.
- Where a per-project deterministic engine exists (buildProjectPlan), use it instead of hand-assembling a materials list — it is grounded in real quantities and per-unit pricing, not a generalisation.
- State the required headcount/quantity explicitly if the customer gave one (e.g. "14 players," "25 units") — a plan that defaults every line to quantity 1 silently under-orders.

## Accessories and completion

- Once the core items are chosen, call showAddons for anything required or commonly needed to actually use them (mounting hardware, a companion part, a consumable) — grouped as required/recommended/optional, never presented as if it were all mandatory.
- A "required" accessory must be something the core item genuinely cannot function without; don't inflate the order with optional items dressed as required.

## Turning the plan into a quote

- Call updateQuote with the real SKUs and quantities once the plan is settled — never state a price or total yourself, the server prices every line authoritatively.
- If updateQuote reports a line as unpriced or not found, say so honestly and offer a real alternative rather than describing the missing item as if it were quoted.
