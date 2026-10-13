# placemakers public-path canary

Spec 1.0.0, 2026-10-13T06:04:28.428Z, 242 ms. **PASS** — 18 scenarios, 18 turns, 0 violation(s), 0 warning(s).

The transcript is sanitised: contact details, tokens, cookies and long identifiers are replaced and session ids are aliased.

> **Note:** This run is hermetic: every hop is the real code, but the store is in memory and the language model is a fixed stand-in. Sentences about safety, verified sources, compatibility and technical suitability are written by the platform from policy and are real; any other reply text is the stand-in model's and says nothing about production wording.

> **Note:** It proves behaviour, not production readiness. The same spec must be run against the live public URL by someone holding a customer session (see docs/okf-platform-implementation.md).

| Scenario | Result | Turns | Cards shown |
|---|---|---:|---|
| fastenings-screws | pass | 1 | products, clarify |
| fastenings-wood-screws | pass | 1 | products, accessories |
| decking-project | pass | 1 | products, accessories, clarify |
| bathroom-vanities | pass | 1 | products, accessories |
| bathroom-renovation | pass | 1 | clarify |
| problem-leak | pass | 1 | — |
| problem-gas | pass | 1 | — |
| problem-unknown-appliance | pass | 1 | — |
| problem-leak-beats-order | pass | 1 | — |
| evidence-install | pass | 1 | — |
| evidence-warranty | pass | 1 | — |
| care-deck | pass | 1 | — |
| technical-suitability | pass | 1 | products, accessories |
| uncovered-product | pass | 1 | — |
| trade-switchgear | pass | 1 | products |
| paint-interior | pass | 1 | products, accessories |
| cleaning-outdoor | pass | 1 | products |
| wet-area-linings-and-waterproofing | pass | 1 | clarify |

## fastenings-screws

A broad request for screws shows examples and asks what they will be fixed into

**Turn 1** — customer: “screws” (110 ms, HTTP 200)

> Here are options from the catalogue.
> Please check compatibility before you buy.

Events: session → capability → uiAction → uiAction → token → done. Cards: products, clarify. Steps: catalog.search.

## fastenings-wood-screws

Wood screws list products and suggest bits as unverified extras

**Turn 1** — customer: “wood screws” (16 ms, HTTP 200)

> Here are options from the catalogue.
> Please check compatibility before you buy.

Events: session → capability → uiAction → uiAction → token → done. Cards: products, accessories. Steps: catalog.search.

## decking-project

Building a deck asks the material, then the size, then shows its categories

**Turn 1** — customer: “i want to build a deck” (11 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → uiAction → uiAction → token → done. Cards: products, accessories, clarify. Steps: catalog.search.

## bathroom-vanities

Vanities show products and suggest tapware and mirrors, in the shop's currency

**Turn 1** — customer: “vanities” (8 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → uiAction → token → done. Cards: products, accessories. Steps: catalog.search.

## bathroom-renovation

A renovation asks its first planning question and shows no products yet

**Turn 1** — customer: “renovate my bathroom” (8 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → uiAction → token → done. Cards: clarify. Steps: —.

## problem-leak

A leak is a problem: no products, cross-sell or checkout, and a professional is named

**Turn 1** — customer: “my bathroom is leaking” (6 ms, HTTP 200)

> I can't give verified safety guidance for this. Please contact a qualified professional.

Events: session → token → done. Cards: —. Steps: —.

## problem-gas

A gas smell is a hazard

**Turn 1** — customer: “i can smell gas” (6 ms, HTTP 200)

> I can't give verified safety guidance for this. Please contact a qualified professional.

Events: session → token → done. Cards: —. Steps: —.

## problem-unknown-appliance

A hazard nobody named still escalates

**Turn 1** — customer: “my appliance is sparking” (6 ms, HTTP 200)

> I can't give verified safety guidance for this. Please contact a qualified professional.

Events: session → token → done. Cards: —. Steps: —.

## problem-leak-beats-order

A hazard outranks an order question in the same message

**Turn 1** — customer: “where is my order? my bathroom is leaking” (7 ms, HTTP 200)

> I can't give verified safety guidance for this. Please contact a qualified professional.

Events: session → token → done. Cards: —. Steps: —.

## evidence-install

How to install something is answered only from verified information; with none, nothing is shown

**Turn 1** — customer: “how do i install a vanity” (6 ms, HTTP 200)

> I don't have a verified source to answer that, so I won't guess. One of our specialists can help.

Events: session → token → done. Cards: —. Steps: —.

## evidence-warranty

A warranty question is answered only from a verified source

**Turn 1** — customer: “what is the warranty on this vanity” (6 ms, HTTP 200)

> I don't have a verified source to answer that, so I won't guess. One of our specialists can help.

Events: session → token → done. Cards: —. Steps: —.

## care-deck

Caring for a deck is guidance that is not invented

**Turn 1** — customer: “clean my deck” (6 ms, HTTP 200)

> I don't have a verified source to answer that, so I won't guess. One of our specialists can help.

Events: session → token → done. Cards: —. Steps: —.

## technical-suitability

A suitability question lists products but does not claim suitability

**Turn 1** — customer: “is this wood screw suitable for a load bearing beam” (8 ms, HTTP 200)

> Here are options from the catalogue.
> Please check compatibility before you buy.
> I can't confirm technical suitability, compatibility or compliance from verified information. These are products we stock; a qualified specialist can confirm the right choice for your requirement.

Events: session → capability → uiAction → uiAction → token → done. Cards: products, accessories. Steps: catalog.search.

## uncovered-product

A product nobody covers is not answered from the catalogue

**Turn 1** — customer: “do you sell flux capacitors” (6 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → token → done. Cards: —. Steps: —.

## trade-switchgear

Switchgear lists products; the shop requires a professional at checkout

**Turn 1** — customer: “switchgear” (8 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → token → done. Cards: products. Steps: catalog.search.

## paint-interior

Interior paint lists products and suggests applicators

**Turn 1** — customer: “interior paint” (6 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → uiAction → token → done. Cards: products, accessories. Steps: catalog.search.

## cleaning-outdoor

Outdoor cleaners list products

**Turn 1** — customer: “outdoor cleaners” (6 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → token → done. Cards: products. Steps: catalog.search.

## wet-area-linings-and-waterproofing

A question about linings and waterproofing for a wet area is helped as the wet-area project: it asks which room, and shows examples from its categories, not one category's products

**Turn 1** — customer: “What moisture-resistant linings and waterproofing do I need for my wet area?” (7 ms, HTTP 200)

> Here are options from the catalogue.

Events: session → capability → uiAction → token → done. Cards: clarify. Steps: catalog.search.

