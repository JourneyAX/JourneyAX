# JourneyX — Team-Design Knowledge & Agentic Experience (thinking + plan)

Written overnight in response to: "build complete Momentec knowledge + decorations/sublimations/PDFs,
AND a US schools/colleges/logos/designs/colors knowledge base, so when a customer says 'I'm from
University of Chicago, I want a basketball kit' the agent already knows and just confirms."

---

## 1. What's running / done tonight
- **Momentec/Augusta complete catalogue** is ingesting via the WebSphere REST connector: per-product
  SKU, price (Offer or MSRP fallback), full specs (gender, garment type, **decoration methods**,
  fabric, sublimation flags), all variant SKUs, images, short+long descriptions, and any PDF/attachment.
  Detached, idempotent, tagged `projectId=augusta`. This is the "decorations / sublimations / product
  catalogue" knowledge — it's happening.

## 2. The US schools knowledge base — split it into two very different things

### 2a. School FACTS — safe, factual, hugely valuable → BUILD THIS
Team **colours (hex)**, **mascot/nickname**, **athletic conference**, **location/state**, **division
(D1/D2/D3/NAIA/HS)**. These are *facts*, not anyone's intellectual property. A returning-customer memory
of "University of Chicago → Maroon (#800000), Phoenix, UAA, D3, Chicago IL" lets the agent **confirm
instead of interrogate** — exactly your goal. This is a clean, ownable reference dataset.
- **Source strategy:** seed from authoritative open datasets (Wikipedia "List of college color
  combinations", teamcolorcodes-style public hex tables, NCAA/US-DoE school directories) — NOT ad-hoc
  Googling per school (accuracy + rate limits). Colours must be *verified*, never guessed.
- **Where it lives:** a **shared cross-tenant reference collection** (`school_directory`), not inside
  one tenant — every teamwear tenant benefits. The agent retrieves it by name to pre-fill the brief.

### 2b. School LOGOS & team DESIGNS — TRADEMARKED → do NOT reproduce
University logos, wordmarks, and uniform designs are **registered trademarks**. Your own spec (Step 2)
already says it right: *"The agent should never automatically reproduce a trademarked design merely
because it found it online"* and *"Research results must show sources and ask the customer to confirm
them."* So the knowledge base must:
- Store the **official source URL** (athletics brand page) as a *reference/citation* only.
- **Never** store or reproduce the logo artwork itself as reusable design assets.
- Require the customer to **upload their own logo + confirm usage rights** (Step 3) before it's used on a
  garment. Licensed reproduction (e.g. an official CLC/Learfield licence) is the customer's to assert.
This isn't a limitation to work around — it's the legal spine of the product. Colours = facts we can
hold; logos/designs = the customer brings and confirms.

## 3. How this maps onto the agentic team-design vision (your 11 steps)

| Step | What it is | Status / where it fits |
|---|---|---|
| 1 Understand project | sport, org, season, size, package, budget, decoration | ✅ our config-driven agent + context dimensions already do this shape |
| 2 Research & brand context | school colours/mascot/conference, **confirm sources** | → **2a school-facts KB** (build) + confirm-with-user guardrail |
| 3 Asset intake & preflight | upload logo/roster; malware, resolution, colour profile, vector? | NEW — file pipeline (out of scope for scraping; a real build) |
| 4 Artwork prep | bg removal, raster→vector, anchor simplify | NEW — Vectorizer.AI / OpenCV (external deps, real cost) |
| 5 Colour normalisation | map to production palette, CIEDE2000 ΔE | NEW — deterministic colour engine (NOT the LLM) |
| 6 Product & placement | compatible garments, placement by sport/method/rules | ⚟ partially: the catalogue (running) + config rules |
| 7 Design variants | 3–5 template-driven variants | NEW — parameterised templates, not free image-gen |
| 8 3D preview | front/back/sides/sleeves/collar/cap | ⚟ we have the Three.js configurator to build on |
| 9 Roster automation | CSV validate: dup numbers, sizes, overflow | NEW — deterministic validator (small, doable) |
| 10 Prompt→structured edits | NL → {move/scale/recolor} JSON, engine applies | ⚟ fits our tool-calling; the *renderer* is the new part |
| 11 Approval & handoff | artwork pkg, seps, roster, preflight, print payload | NEW — production pipeline |

**Honest read:** Steps 1, 2 (facts), 6, 8, 9, 10 are within reach on what we've built (config agent,
configurator, quote/order, tool-calling). Steps 3–5, 7, 11 are a **separate multi-month production
program** with real external dependencies (vectorisation, colour science, print handoff) and should be
scoped as its own track — not conflated with catalogue ingestion.

## 4. Recommended sequence
1. **Finish the Momentec catalogue** (running) → the product knowledge is complete.
2. **Build the school-FACTS KB (2a)** from an authoritative dataset → the "UChicago → Maroon, confirm"
   experience. Cross-tenant reference collection + agent retrieval + returning-customer memory.
3. **Wire step 2 into the agent**: on "I'm from <school>", look up facts, present colours/mascot/
   conference **with the source**, and ask the customer to **confirm** (never assume).
4. **Then** scope the design-studio program (steps 3–5,7,11) separately — it needs real infra + budget
   decisions (Vectorizer.AI, Google Vision, a colour engine), and the IP/licensing model for logos.

## 5. What I will NOT do (and why)
- Won't scrape/store university **logos or uniform designs** as reusable assets — trademark/IP.
- Won't **guess** school colours — inaccurate brand colours are worse than none; they must be sourced.
- Won't claim to autonomously crawl "all US schools" overnight — that's a data-partnership/dataset job,
  not an ad-hoc scrape, and doing it wrong creates bad data + legal exposure.
