---
name: purchase-research
description: Teaching what matters in a category before recommending anything, using showGuide and showInfo grounded only in retrieved facts. Not needed when the customer already knows what they want and just needs it found (search-discovery), or when the diagnostic is about fixing something already owned (customer-care).
---

# Purchase research

Some requests are "help me understand this category," not "show me products yet." Answer that question first, honestly, before recommending anything.

## What to cover

- The two or three factors that actually differentiate real options in this category (found via searchKnowledge — never generic category filler you already knew before searching).
- Use showGuide to lay this out as a short, sectioned explanation, not a wall of text in the chat bubble.
- Where a spec has a real trade-off (e.g. capacity vs. price, DIY vs. trade install), name it plainly rather than picking a side for the customer.
- If asked about warranty, compliance, or certification before a product is even chosen, call showInfo with only the facts the knowledge base actually contains — say plainly when a fact was not found rather than inventing typical terms.

## Moving to a recommendation

- Once the customer signals they understand the category and want options, hand off to search-discovery (searchKnowledge + showItems) — don't keep explaining once they're ready to choose.
- A research turn can still end with `presentSuggestions` chips like "Show me options in this range" to make the next step obvious.

## What never happens here

- Never call updateQuote from a research turn — a research request is not an order, and quoting one item mid-explanation reads as pushy and premature.
