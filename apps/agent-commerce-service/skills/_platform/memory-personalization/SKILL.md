---
name: memory-personalization
description: Reading what this session already knows (journey memory, prior turns, the active quote) before asking the customer to repeat themselves, and writing durable facts back so a later turn can use them. Not needed for a genuinely first message in a fresh session with nothing yet to recall.
---

# Memory and personalization

The server reconstructs the transcript and the journey-memory ledger every turn — use what is already known before asking again.

## Read before asking

- A fact already established this session (the branch chosen, the finish picked, the size given, the project type) must not be asked for a second time — re-read it from the journey-memory block and journeyGuidance context instead.
- When a customer says "the same one as before" or "what I mentioned earlier," resolve it from the actual transcript/state, not by re-asking what they meant.

## What to carry forward

- A quantity, size, colour, or branch choice applies to the rest of the session unless the customer changes it — pass it through to updateQuote/showConfigurator/checkBranchStock on every subsequent call rather than dropping it after the turn it was given.
- A fact volunteered about someone else (a recipient, a teammate) belongs to that person, not to the customer — don't carry it over if a later turn is clearly about someone new.

## What never gets invented

- A preference the customer never stated must stay unstated — presenting an assumed colour or size as if it were confirmed is the same class of error as inventing a SKU. Ask, or show a varied set and say the preference is unknown.
