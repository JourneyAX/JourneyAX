# Virtual Try-On — capability spec (roadmap, not built)

**Positioning (must hold):** "See how the style *may* look on you" — a visualization, NOT a fit guarantee.
Never claim exact tightness, size, drape, or physical fit from the generated image.

## Flow
1. In the journey, on a product the shopper likes, offer **"Try it on."**
2. Shopper uploads one clear photo (front-facing, garment area visible). Explicit consent; photo is
   theirs, used only for this render, retention policy TBD (default: ephemeral, not stored).
3. App sends to the image-editing API: **person photo + product image + garment metadata** with an
   instruction like: *"Apply the garment in image 2 to the person in image 1. Preserve face, body
   shape, pose, skin tone, background, lighting. Reproduce the garment's exact colour, neckline,
   sleeves, pattern, length, material. Photorealistic."*
4. Show the result in the 60% panel with the honesty caption + actions: **Try another colour**,
   **Find my size** (→ sizing engine), **Add to cart**, **Complete the look**.

## Architecture (combine, don't rely on the image alone)
- **Image generation** — OpenAI image editing (gpt-image / multi-image reference) OR Google Gemini
  2.5 Flash Image ("nano banana") for the realistic visualization. Provider behind the existing
  multi-LLM abstraction; per-project key.
- **PIM / catalogue** — exact colour, material, cut, length from our product record (the crawl already
  captures colours + images; feed the *right* variant image as the garment reference).
- **Sizing engine** — size recommendation (the `recommendedSize` we already surface) for "Find my size".
- **Commerce** — Try another colour / Add to cart / Complete the look reuse existing journey actions.

## Guardrails
- Real-person image generation is sensitive: consent gate, no storage by default, no minors, watermark
  or "AI preview" label on the output, and never present it as a true photo of the customer wearing it.
- Quality varies (artifacts on complex poses/patterns) — treat as a delight feature, gate behind
  "Preview (beta)".

## Effort
Non-trivial: upload UI + consent, image-API integration + provider abstraction, result panel + actions,
storage/retention policy. Estimate: a focused multi-day build. Lower priority than catalogue + reviews.
