# CDL (Custom Design Line) — overnight build report

**Date:** 2026-08-12 (built while you slept)
**Scope you set:** *"Implement end-to-end without any fail — uploading AND generating, along with the chat, the designs and the aesthetics; the creator can validate; attach the test scripts."*

**Status: shipped and tested end-to-end.** One automated suite, **16/16 checks pass, 0 fail.**

---

## What CDL does now (in the journey chat, not a separate screen)

CDL lives **inside the 40/60 storefront conversation** (your call). Two front doors, one engine, the artist as the production authority:

```
            ┌─ DOOR A: "design it with us" ──┐
Customer →  │  describe → AI generates a     │
            │  concept (nano-banana)         │ ─┐
            └────────────────────────────────┘  │
            ┌─ DOOR B: "upload my design" ───┐   ├─→ analyse the garment
            │  drop an image in the chat     │ ──┘    → match the 364-template library
            └────────────────────────────────┘        → USE (we make it) or CREATE (new)
                                                              │
                     USE → render the real template in 3D ◄───┤
                     CREATE → queue new cut pieces  ◄──────────┘
                                                              │
                     → artist reviews → customer agrees → READY FOR PRINT
```

### Door A — design it in the chat (the differentiator)
The customer **describes** a jersey ("navy and orange baseball jersey for the Cougars, #30, aggressive") and the agent **designs it right there** using the nano-banana image engine (Gemini 2.5 Flash Image, the one we built for A&F try-on; OpenAI `gpt-image-1` fallback). The generated concept shows as a **"Your concept"** thumbnail beside the 3D garment. They never leave us for ChatGPT.
*Browser-verified:* the concept rendered a real navy/orange "COUGARS 30" jersey next to the matched producible template.

### Door B — upload my design (the fallback)
The customer drops an image into the chat (paperclip / paste / drag-drop). The agent reads it, matches it, and lands them in the 3D configurator on the real template.
*Browser-verified:* uploaded jersey → agent read it → rendered a real 3D navy/orange Grand Slam jersey with "Add to kit", and explained the colour substitution in chat.

### The honest boundary (your "source problem")
A generated **or** uploaded image is still a *picture*, not a garment. Both go through **analyse → match**:
- **USE** — we already make this style with all the needed sizes → render the real template, design it, order.
- **CREATE** — no matching pattern (new silhouette, or a size we don't cut) → flagged for the artist to generate cut pieces at all sizes. No style code is invented.

### Artist validation (the creator gate)
Every custom design goes through a two-authority gate — **neither can act for the other**:
`pending_artist → artist_approved → customer_agreed → ready_for_print` (artist can send it back with `changes_requested`).
The customer **cannot** agree to print before the artist approves — enforced and tested.

---

## How to run the tests

```bash
bash scripts/cdl/cdl-e2e-test.sh
```
Needs the local stack up (product-service 8083, gateway 3010, agent 3004) and `augusta` with the `customDesign` capability published (done — config v29).
`SKIP_IMAGEGEN=1 bash scripts/cdl/cdl-e2e-test.sh` skips the two paid image-generation calls.

**Last run: PASS=16 FAIL=0 SKIP=0.** Coverage:
| # | Check | Result |
|---|-------|--------|
| 0 | preflight (key, product-service) | PASS |
| 1 | template library ≥300 (364) | PASS |
| 2 | Door B analyze via imageUrl → USE + real SKU | PASS |
| 3 | Door B analyze via base64 (the 413 body-limit regression) | PASS |
| 4 | render matched template (texture + glb) | PASS |
| 5 | chat: uploaded design → analyzeDesign + showConfigurator | PASS |
| 6 | Door A: brief → concept generated (nano-banana) + matched + served | PASS |
| 7 | CREATE branch: no-template + missing-size → decision "create" | PASS |
| 8 | artist validation: submit → block-early-agree → approve → agree → print | PASS |
| 9 | chat: "design me…" → generateDesign + concept + configurator | PASS |

---

## What I built (files)

**product-service**
- `src/cdl.controller.ts` — `POST cdl/design` (generate→analyze→match), `GET cdl/concept/:id` (serve concept), and the review lifecycle: `POST cdl/review`, `POST cdl/review/:job/artist`, `POST cdl/review/:job/agree`, `GET cdl/review/:job`, `GET cdl/reviews`.
- `src/tryon.service.ts` — new `generateFromPrompt(prompt, refImage?)` (reuses the nano-banana engine for text→image + iterate).
- `src/main.ts` — raised JSON body limit to 10 MB (**was silently 413-ing on base64 images**).

**agent-commerce-service**
- `src/agent.service.ts` — new tools `analyzeDesign`, `generateDesign`, `submitForReview`, `checkReviewStatus`; all gated by the `customDesign` capability; deterministic force of the configurator on a USE match; capability nudge that routes "design me…" to generation and "send to artist" to review.
- `src/agent.controller.ts` — threads the attached `imageBase64` through chat + chat/stream.

**journeyax-web (storefront)**
- `src/components/ChatPanel.tsx` — image upload (paperclip / paste / drag-drop), `imageBase64` in the request, `showConcept` handling.
- `src/components/panels/ConfiguratorPanel.tsx` — "Your concept" thumbnail.
- `src/context/JourneyContext.tsx` + `src/lib/types.ts` — `conceptId` state + `SET_CONCEPT`.
- `src/app/api/cdl/concept/[id]/route.ts` — same-origin concept-image proxy (fetches product-service directly — the gateway can't proxy binary).

**tests / docs**
- `scripts/cdl/cdl-e2e-test.sh` — the suite above.
- this report.

---

## Update — colour + design-line application FIXED (browser-verified)

Gap #1 below is now resolved. The root cause was the *model* building the configurator args and dropping colours (only `accentColor` survived → the render cycled one colour across every zone → solid garment). Fix:
- product-service returns a **`suggestedConfig`** on a use-match: every analysed colour mapped onto the style palette (`normaliseColour`), with the accent picked to **contrast** with the body (`hueFamily` — navy body → orange accent, not a second blue), plus the **team name + number read off the design** (analyzer now extracts legible `text`).
- the agent emits `showConfigurator` **deterministically from `suggestedConfig`** (server-decided, not model-decided), and tells the model it's already rendered so it can't re-emit worse args.
- browser-verified: uploaded jersey → 3D renders **navy body + orange accents + "COUGARS 30" in white** (was solid orange). Test #5 now asserts `baseColor`+`accentColor` are present. **16/16 still pass.**

## Known polish gaps (not blockers; noted honestly)

1. ~~**3D colour application on generated designs**~~ — **FIXED** (see Update above). Remaining nuance: colour *roles* come from the analyser's colour order + a hue-contrast heuristic, so an unusual palette may still put the "wrong" colour on the accent; the customer/agent can swap it in one click.
2. **Concept store is in-memory** (product-service), LRU-capped at 200. Fine for the demo; swap for the per-project GCS bucket (AUG-8) in production. Reviews likewise are in-memory (swap for a Mongo `cdl_reviews` collection — same shape).
3. **Agent submit timing** — the agent reliably calls `submitForReview` once a design is in the session; on a cold "send it to the artist" with no prior design it renders first. Real journeys always have a design by then.
4. **CREATE branch is a queue + honest message**, not yet actual cut-piece geometry generation (Seamly2D block → grade). That's the deep/rare case from the research doc; the hand-off and artist queue are in place for it.
5. **Artist UI** — the artist actions are API endpoints (tested). A back-office "artist queue" screen to click Approve/Request-changes is the natural next surface.

## Suggested next steps (your call in the morning)
- Wire colours+design-line from the analysed concept into the forced configurator (closes gap #1 — biggest visual win).
- Build the back-office **artist review queue** screen on top of `GET cdl/reviews?status=pending_artist` + the artist endpoint.
- Persist concepts + reviews to Mongo/GCS.
- Start on the real CREATE geometry (Seamly2D block → cut pieces → grade) for the true no-template case.
