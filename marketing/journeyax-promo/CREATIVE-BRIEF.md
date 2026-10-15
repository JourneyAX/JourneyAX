# JourneyAX — voice-free product film

## Deliverable and intent

- Main cut: 2:53, 16:9, 1920×1080, 24 fps, silent. Designed to work without narration.
- Audience: merchants and commerce leaders. One clear idea: customers arrive with goals; JourneyAX guides them from intent toward a useful outcome on the merchant's site.
- This is a **concept film**. The Go and Studio screens, chart, dialogue and cards are designed illustrations, not captures of the live product or a claim that every connector is already deployed. No invented SKUs, prices, conversion numbers or customer records.
- Style: premium editorial photography, crisp black/cream UI, signal yellow used for decisions and progression. Match the JourneyAX website and Studio palette: `#070707`, `#0E0E0E`, `#FFFDF6`, `#F4F2EA`, `#FFD600`.
- Authentic wordmark: `assets/logo-yellow.png` copied from the repository's JourneyAX brand assets. Do not redraw the logo or use an AI-generated wordmark.
- No voice. Optional original/licensed instrumental only, with a slow pulse; provide a silent export as the master. No reference-video footage or audio is reused.

## The story, on screen

| Time in cut | Visual and action | On-screen words | Editor direction |
|---|---|---|---|
| 0:00–0:14 | Customer considering a laundry renovation | Customers arrive with a goal. “I’m renovating my laundry.” | Slow push toward homeowner; let the sentence appear in two beats. |
| 0:14–0:26 | Four disconnected boxes: search, filters, PDFs, quote form | The experience is still fragmented. | Boxes arrive separately; dotted connections show the handoffs. |
| 0:26–0:38 | JourneyAX wordmark and continuous line | One continuous buying journey. | Line resolves from four disconnected segments into one stroke. |
| 0:38–0:51 | Merchant consulting a shopper in a showroom | Bring the best of consultative selling online. | Gentle lateral move; highlight “Remember the goal” then “Explain why.” |
| 0:51–1:06 | Studio Business Pack concept | Make it your brand. | Build six tiles in sequence: voice, journeys, catalogue, knowledge, rules, cards & themes. |
| 1:06–1:21 | Existing merchant systems connect into the Pack | Your systems become one guided experience. | Draw connection lines from catalogue, stock/pricing, knowledge and commerce. Do not imply all integrations are live. |
| 1:21–1:38 | Go customer view; customer opens with laundry goal | Start with the customer’s goal. | Type the customer's sentence; visual canvas appears beside chat. |
| 1:38–1:53 | Clarification and remembered context | Ask only what helps the decision. | Surface side-by-side/stacked choices, with “laundry renovation” visibly remembered. Cards are conditional, not compulsory. |
| 1:53–2:10 | Three illustrative category cards with reasons | Show options. Explain why. | Bring cards in only after enough context. Reason labels animate just after each option. No invented price or SKU. |
| 2:10–2:26 | Product choice → verified details → basket/quote → connected checkout/handoff | The journey continues toward an outcome. | Move a yellow progress line through the four stages. Qualify claims and actions by merchant configuration. |
| 2:26–2:41 | Studio insights and controls | Improve the journey from Studio. | Draw the flow line; reveal questions to improve and editable brand controls. Chart is illustrative, with no fake metrics. |
| 2:41–2:53 | JourneyAX wordmark / CTA | From first question to the next confident step. | Resolve the path back into the brand mark; finish on journeyax.com. |

## Story rules for the edit

1. The laundry example is a **demonstration of a flexible method**, not a hardcoded PlaceMakers journey. Alternate versions could start with apparel fit, a bathroom project or a B2B quote; the same platform structure adapts to the merchant.
2. The assistant never fires a product grid just because the customer typed a noun. It first identifies the goal, uses remembered context, asks a relevant question only when needed, and then displays the appropriate surface.
3. The merchant controls the brand experience through Studio and its Business Pack. Catalogue items, supported claims, journey steps, questions, cards, styling and enabled actions are merchant-specific. Platform features such as 3D configuration can be offered when appropriate.
4. Recommendations must say **why** they fit. Warranty, installation, compatibility and care are displayed only if the source is verified and applicable. Cart, quote, checkout and handoff appear only where the merchant has connected those actions.
5. Do not say “fully autonomous”, “guaranteed conversion”, “all integrations live”, or “production-ready” without separate substantiation. Do not use OKF, cutover, MongoDB, LLM, model-provider names or other implementation jargon in the film.

## Master prompt for the video editor / generation agent

Create a premium, voice-free 16:9 JourneyAX marketing video using the 12 supplied 1920×1080 scene images in `output/`, the two original photographic assets and the authentic logo in `assets/`, and the timing above. Total length about 2:53. Preserve all on-screen wording and brand colors. Use restrained kinetic typography, line-draw animation, masked reveals, gentle parallax on photographs, and purposeful UI simulation—not generic bouncing cards, random stock footage or an imitation of the Vimeo reference. Make the problem-to-solution arc legible with sound off. In Go, animate the customer goal first, then remembered context, one relevant clarification, three illustrative recommendations with a clear reason for each, and finally cart/quote. In Studio, animate the Business Pack and connections as merchant-controlled configuration. Keep every mock screen visibly illustrative. Do not invent SKUs, prices, metrics, production screenshots or active integrations. End on the authentic logo and journeyax.com. Export an H.264 MP4 at 1920×1080/24 fps with **no voice and no audio track**, plus a version with only licensed instrumental music if rights are cleared. Deliver editable project source and a 30-second social cut.

## Prompt for enhancing each photographic scene

Use the provided original still as a visual reference; do not change the people or room. Create a subtle 8–14 second cinematic camera move only: 3–5% push-in, slight depth separation, natural daylight variation, no talking, no lip sync, no morphing, no new text or logos. Preserve the dark negative space on the left for typesetting. Keep the scene believable and the JourneyAX overlay exactly as supplied.

## Five-minute expansion (optional, not required for the main cut)

Add about two minutes *after* the main customer journey and before the closing brand frame. Use three short examples, each with one goal and a different visual decision: (1) a broad shopping query that can show a useful overview and an optional narrowing question; (2) a problem statement such as a leak that first addresses urgency and safety before any product recommendation; (3) a configurable apparel or sportswear journey where a 2D/3D visual helps the customer choose. Then add a 30-second Studio segment showing how a merchant updates knowledge, visual cards and journey logic before publication. All examples remain illustrative and source-qualified; do not imply that the specific live tenant flow has been verified.

## Build / source map

- `render.mjs` generates the 12 scene PNGs and the silent MP4 using the local assets. Run `node marketing/journeyax-promo/render.mjs --video` from the repo root. Requires the existing `sharp` dependency and `ffmpeg` on PATH.
- `output/journeyax-promo-silent.mp4` is the animatic/first cut. It uses crossfades and extended reading time; an editor should apply the per-scene motion above for the final polished release.
- `output/01-*.png` through `output/12-*.png` are individually editable scene references. `output/timing.json` gives scene lengths.
- The two original photographic assets were generated specifically for this film. Their source prompts were: (a) homeowner considering a modern New Zealand laundry renovation, editorial warm light, dark left negative space; (b) merchant advising a shopper in a building-supplies showroom, materials on right, dark left negative space. Both explicitly excluded text, logos and UI.
