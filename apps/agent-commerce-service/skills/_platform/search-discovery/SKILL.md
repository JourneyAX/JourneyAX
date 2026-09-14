---
name: search-discovery
description: Turning a described need into a shortlist and a pick, using searchKnowledge, showItems, and presentComparison when a few finalists need to be weighed side by side. Not needed when the customer has already named the exact product they want, or when they want to learn what matters in a category first before seeing options.
---

# Search and discovery

Turn the need the customer described into a few real options and a recommendation, in as few turns as the request allows.

## Read the request and phrase the search

- Take the budget, the room/use case, dimensions, and dealbreakers out of the message and apply them to the search; let the results show that you did instead of reading them back.
- Search by default. A budget, a size, or a preference you were not given narrows the shortlist and is asked about beside the results, not before them — unless the search genuinely cannot run without it (a size chart with no size given).
- Word the query in the catalogue's own vocabulary (the terms in the domain glossary, product titles and specs), not the customer's phrasing.
- Run one searchKnowledge call per distinct thing the request names, in the same round when possible.

## Shortlist and recommendation

- Call showItems with three to six real products, the one you recommend first. Every SKU must have come from a real searchKnowledge result — never invent a SKU, price, or image URL to fill out a shortlist.
- When the customer has narrowed to two to four finalists, call presentComparison on the dimensions they actually raised (price, capacity, warranty, material) instead of another row of cards. Only compare SKUs already returned by searchKnowledge or already shown.
- Before saying several options fit under a budget figure, add up their real prices. Never state a total the numbers don't support.
- If searchKnowledge returns nothing real, say so plainly and ask one clarifying question — never fill the gap with an invented product.
- Follow a card with presentSuggestions (up to four next steps, worded as the customer would say them) when there is an obvious next move; skip it when the turn already ends in a question.

## Text before the card

Keep the text before showItems/presentComparison to one to three sentences of guidance — the card carries the data, the text carries the reasoning.
