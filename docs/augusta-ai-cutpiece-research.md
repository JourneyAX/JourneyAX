# Augusta / Under Armour — AI-to-Cut-Piece: Market, Technical & Infrastructure Research

*Prepared for JourneyAX. Research-only — no build. Companion to `Augusta_UA_AI_Cut_Piece_Requirements.docx` (v1.0, Aug 2026), whose full text is attached in Appendix R.*

---

## 0. TL;DR — the one insight that shapes everything

The requirement asks for two things that live in **different universes**, and the whole design succeeds or fails on keeping them separate:

| | **Proof / concept layer** | **Production / geometry layer** |
|---|---|---|
| What it is | A *picture* of the jersey the customer is converging on | The *spec* to actually cut, print and sew it |
| Data | Flattened raster (PNG) | Vector art + graded cut-piece geometry + bleed + real fonts + color separations |
| Who drives it | **The customer, conversationally, in seconds** | **The artist**, tool-assisted |
| Can it be free + instant? | **Yes** — this is the JourneyAX 40/60 chat magic | Partly — free tools do a lot; UV↔cut-piece mapping is the one hard gate |
| Failure if you blur them | You ship a "picture of a jersey" as a cut file → unmanufacturable | You make the customer do CAD → journey dies |

**The market has already voted on this split.** PROLOOK PRO-AI — the closest competitor to this exact idea, launched July 2026 — is explicitly *"design your concept in ChatGPT → upload → we return a **production-accurate proof**, and if adjustments are needed we show you exactly what and why."* Their "AI" is a **front door**; a human + pre-engineered templates do the production conversion. That is the honest shape of this product, and it matches the requirement's own line: *"the artist remains the production authority… give artists a structured, editable, cut-piece-based starting point."*

So the winning strategy is **not** "AI turns a picture into a factory file." It is:

> **A conversational proof studio (free, seconds, no drag-drop) that hands a clean, structured, cut-piece-aware package to the artist — who finishes it in free production tools.** JourneyAX owns the customer-facing 40/60 conversation; the artist owns the seam-accurate finish.

Everything below is the research behind that sentence.

---

## 1. What the requirement actually asks for (analysis)

The docx is a genuinely strong PRD. Re-reading it against the market, five things stand out:

1. **It is deliberately humble about automation.** "This release should not be positioned as replacing artists… no reduction in artist time is required for POC acceptance." That is *correct* and matches every serious vendor (Optitex, Browzwear, CLO are all artist-driven; only POD mockup generators are "fully automatic," and they're shallow). Do not let anyone reframe this as "AI removes the art team" — the research says that product does not exist for free (or at all, reliably).
2. **The core deliverable is a *translation layer*, not a design tool** — "the bridge between customer AI artwork and the existing production design environment" (§3). The bridge, not a new Illustrator.
3. **The hardest single requirement is FR-08 + §1's size-grading** — "generate artwork for each selected size **without merely scaling the entire flattened image**." This is the trap that kills naïve implementations (see §4 and §6).
4. **The UV-match gate (§10) is the real automation boundary** — "if the 3D UV map does not match the cut-piece PDF, flag the template as invalid for automation." This one sentence decides what can be automated for free vs what needs paid CAD/an artist (see §6).
5. **The CDL 10-step workflow (§6) is the spine.** The rest of this document maps each of those 10 steps to the best available free tools and marks where the artist/paid boundary falls.

The complete, unabridged requirement is attached in **Appendix R** so this document is self-contained.

---

## 2. How the market does this today

The relevant market is a stack of four capabilities: **AI concept intake → apparel pattern intelligence → vector/Illustrator editing → 3D garment validation.** Nobody sells all four as one cheap product; everyone is artist-in-loop at the production end.

| Vendor | What it actually does | Automated vs artist | Cost | Lesson for JourneyAX |
|---|---|---|---|---|
| **PROLOOK PRO-AI** | Customer concepts in ChatGPT/any AI, uploads mock-up + details, receives a **production-accurate proof**; "we identify adjustments and explain why," then roster + order. | **Ops/artist-in-loop.** AI concept is an *input*, not the product. | Quote-based B2B | This is the exact play. Win by making the proof loop **more connected to real cut pieces + 3D**, and **conversational** rather than a form. |
| **Optitex 3D Design for Illustrator** | Plugin: pull a real 3D garment *into Illustrator*, place print/graphics on it, preview in 3D, export glTF. | Artist-driven; garment must pre-exist from patterns. | Paid + Illustrator | The gold reference for "same artwork on real garment geometry." Benchmark, not buy. |
| **Browzwear VStitcher + API** | Builds true 3D garments from 2D patterns (imports DXF-AAMA/ASTM); Python API exposes garments/materials/colors + a Render API (images, turntables, OBJ/FBX/glTF). | Scriptable via plugins, but base garment is patternmaker-built. | Enterprise seats | The only one with a real automation API — a *future* high-volume option, not MVP. |
| **CLO / CLO3D** | Industry-standard 3D garment CAD; imports/exports DXF-AAMA & DXF-ASTM with outlines, notches, grainlines; UV derived from the draped pattern. | Artist-driven. | Paid subscription | The reference for "UV island == cut piece." Explains the §10 gate. |
| **Printful / Printify AOP generators** | Upload one flat image onto a per-product **template**, get a realistic mockup + a real print file **for their own blanks**. | **Fully automatic but shallow** — a cosmetic warp of your art onto a garment photo; no graded per-panel cut pieces; only their catalog. | Free tool, pay per unit | Proof that "auto" only works when *someone pre-engineered the template*. That pre-engineering is exactly Augusta's cut-piece registry (§8). |
| **Vectorizer.AI / Adobe Image Trace / Firefly Services** | Raster→vector conversion (logos/flat art) via API. | Utility | Paid ($10–$5k/mo; Firefly enterprise-only) | Useful for logos only; **useless on photographic AI full-body art** (all tracers over-segment it). Free equivalents exist (§5). |
| **Magnific / Freepik upscaler** | AI upscale to print resolution. | Utility | Paid | Optional image prep; solves nothing about cut pieces. |

**The pattern across all of them:** the "AI" is intake and exploration; **pre-engineered templates + a human** are how anything reaches production. The requirement's cut-piece registry (§8) *is* Augusta's version of the pre-engineered template — that's the asset that makes automation possible later.

---

## 3. The conversational 40/60 experience (no drag-drop) — how it can actually work

The user's direction is explicit: **the customer edits by talking, not by dragging** — "upload the input, and in a matter of seconds make those colors, logos, modifications happen… in simple conversation, not dragging/editing tools." This is the JourneyAX 40/60 pattern (chat left, live proof right). The research says this is the *most* achievable part — and free.

### 3.1 What "edit by talking" maps to technically

Modern **instruction-based image-edit models** take an image + a natural-language instruction and return the edited image — exactly the interaction the user wants. As of 2026 the field is strong:

| Model | Free? | Open weights (self-host) | Best at | Region-only edit (rest pixel-identical)? | Text (names/numbers) | Logo fidelity | Commercial license |
|---|---|---|---|---|---|---|---|
| **Gemini 2.5 Flash Image ("nano-banana")** | **~500 edits/day free API** | No (API) | Fast conversational edits, scene consistency | Approximate (re-encodes whole image) | Good; Pro ~94% but no free tier | Good w/ reference | **Yes** — Google grants commercial rights (free tier adds a visible watermark) |
| **Qwen-Image-Edit (Alibaba)** | Weights free | **Yes (Apache-2.0)** | **Best open editor**; best open text; native ControlNet + multi-image | Good; lock with ControlNet/mask | **Best among open** | Native ControlNet helps lock a logo | **Yes (Apache-2.0)** ← only top-tier *open + commercial* editor |
| **FLUX.1 Kontext [dev]** | Weights free | Yes | Iterative local edits, subject preservation | Strong context-preserve, not pixel-locked | Decent | Preserves subjects | **NO — non-commercial license** (trap) |
| **SD/SDXL inpaint + ControlNet + IP-Adapter (ComfyUI)** | **Free** | Yes | **Masked region edits — the *guarantee* layer** | **Yes — genuinely pixel-identical outside the mask** | Weak (composite text instead) | **Best control** (mask + reference, or composite real logo) | Yes |
| **Ideogram V3** | Free 10/day | No | **In-image typography** (~90–95%) | No | **Best text** | n/a | API paid |
| **ByteDance Seedream 4 / SeedEdit** | API, some trials | No | High-quality 4K edits, sequence consistency | Approximate | Strong | Strong | Paid at volume |
| **Recraft V3** | Small free tier | No | **Vector/SVG output** (closest to production) | No | Strong | Clean vector-style | Paid |

**Two facts that drive the design:**

- **"Change only the sleeve, keep the rest identical" is only *guaranteed* by masked inpainting (ComfyUI).** The chat-style transformers (nano-banana/Kontext/Qwen/Seedream) re-encode the whole image, so unmasked areas *drift* subtly even when they look preserved — noticeable when a customer A/B's before/after. So the free stack is **hybrid**: a conversational model for creative/global edits, backed by **masked inpainting** for surgical ones.
- **A logo must never be regenerated.** The reliable, free trick: mask the logo out, edit everything else, then **composite the original logo PNG back on top** (warped to the garment). Byte-exact, trademark-safe. Same for exact team wordmarks / player names — **composite real fonts**, don't trust generated text for the final.

### 3.2 The conversational grammar (what the customer says → what happens)

The 40/60 chat can expose a small, reliable verb set — each mapping to a free operation. No canvas, no handles:

| Customer says… | System operation (free) |
|---|---|
| "Make the sleeves navy." | Auto-mask sleeve region → inpaint recolor → re-render proof |
| "Swap our crest for this one." (uploads logo) | Composite uploaded logo at the anchor, aspect-locked |
| "Name across the back: RIPPERS, number 23." | Real-font text layer at the back anchor (not generated) |
| "Move the logo up a bit / make it bigger." | Adjust the composited logo transform at its anchor |
| "Try it in green and black." | Palette-swap pass (recolor), show variants |
| "More aggressive, more cracks in the pattern." | Instruction edit on background art only (logo/text masked out) |
| "Looks good — order it." | Freeze proof → generate the artist hand-off package (§6, steps 4–7) |

This is exactly the M&M'S / configurator muscle JourneyAX already has (chat → `showConfigurator`/render), pointed at a garment texture. The **conversational proof loop is the cheap, high-magic 80%.**

### 3.3 Where the conversation must *stop* and hand off

A flattened raster edit is a *picture*, independent of how good the chat gets:
- AI "text" is drawn shapes, not a font at exact size/kerning → fails production QA.
- Screen effects (soft gradients, glows, anti-aliased fuzz) don't survive press at print size.
- No cut-piece geometry, no bleed, no color separations, no vector paths.

So the chat editor is a **fast approval loop**; the instant the customer approves, the design is **re-authored** for production. Build a hard, explicit **"approve → convert"** boundary. (PROLOOK's "production-accurate proof + human adjustment" is exactly this boundary made visible.)

---

## 4. The size-grading trap (why "one image → all sizes" is a lie)

The requirement's hardest line (FR-08, §1) deserves its own section because it's the most common way these projects fail.

Producing S/M/L/XL is **not** scaling the mockup. Patterns are **graded**: each dimension grows by garment-specific, **non-uniform** rules (chest +2 cm, sleeve +1.5 cm, neck +0.5 cm per step). The *panel changes shape*, not just size. Therefore:
- A logo "8 cm below the collar" must stay 8 cm below the collar on **every** size (an anchor rule), not scale with the image.
- A stripe that meets at a seam must **still meet** after the seam moved due to grading.
- Art must be **re-projected per graded size**, not resampled.

A single scaled PNG breaks seam matches and placement across the run. This is why the free/automatable path needs **anchor rules + per-size cut-piece geometry**, and why the cut-piece registry (§8) is "the critical foundation" the doc calls it.

---

## 5. The production hand-off, done for free (raster → editable vector → print PDF)

Once the customer approves the raster proof, here is the **zero-cost** path to an artist-editable, print-ready package. The rule that governs it: **trace what's flat, place what's photographic.**

| Stage | Free tool | Role | Where it falls short vs Adobe |
|---|---|---|---|
| Palette-lock / DPI | **ImageMagick** (`-posterize`, `-resample`) | Reduce colors before tracing; hit print DPI | No live soft-proof |
| Trace **logos/text/flat art** | **potrace** (1-color, cleanest Béziers) / **VTracer** (flat color, MIT) | Raster→clean editable SVG paths | Adobe Image Trace / Vectorizer.AI group color slightly better; free needs node cleanup |
| **Do NOT trace** full-body/AI art | — | Keep as high-res raster, **place with bleed** | (Correct behavior — every tracer over-segments photographic art) |
| Assemble **layered, editable file** | **Inkscape** (free Illustrator substitute) | Layered **SVG 1.1** that opens in Illustrator with layers intact | SVG↔AI layer round-trip is lossy; no native `.ai`; keep layer tree shallow |
| **CMYK / spot / bleed / PDF-X** | **Scribus** (free InDesign substitute) | PDF/X-3 or X-1a for the sublimation RIP | No Pantone library (licensing) — confirm printer accepts generic spot/RGB |
| Headless color convert | **Ghostscript + littleCMS** | RGB→CMYK + PDF/X flatten with printer ICC | Color needs careful ICC params; no interactive preview |
| **Cut-piece geometry (DXF)** | **ezdxf** (Python, MIT) | Read/write DXF cut/sew/bleed/notch layers; export ASTM-D6673 (Gerber) | Not natively fully AAMA/ASTM-compliant; model layers deliberately |
| **Pattern drafting + grading** | **Seamly2D / Valentina** (GPL) | Measurement-driven **regrade** (true grading, not image scale) → DXF/PDF | Not as polished as Gerber/Optitex |

**The critical layer-structure fact:** Illustrator **opens SVG and preserves layers as editable**. So a clean layered SVG 1.1 out of Inkscape is a legitimate free hand-off that matches the requirement's §9 layer spec (`01_TECHNICAL_DO_NOT_EDIT`, `02_BACKGROUND_ART`, `03_LOGOS`, …). Keep layers top-level and shallow so Illustrator maps them cleanly.

**Two hard limits vs Adobe** (be honest with Augusta): (1) no native `.ai` — you hand off SVG/PDF, not `.ai`; (2) no Pantone spot library — confirm the printer's color workflow. Neither blocks a POC.

### Print specs the free tools must hit (dye-sublimation)
- **Effective resolution:** ≥ **150 DPI at final print size** (300 DPI for small detail).
- **Bleed:** **3 mm / 0.125"** all sides; keep critical elements ≥ **0.25"** inside trim.
- **Color:** many textile RIPs *prefer sRGB* and convert internally; others want **flattened CMYK PDF at 300 DPI with bleed** + the printer's ICC. **Ask the specific printer** (this is one of the doc's own open questions, §15). Build to emit either.

---

## 6. The CDL 10-step workflow, mapped to free tools + the artist boundary

This is the deep dive the user asked for — the requirement's §6 workflow, each step marked **[AUTO-FREE]** (automatable now with free tools), **[AUTO-w/REGISTRY]** (automatable once the cut-piece registry exists), or **[ARTIST]** (needs a human or paid CAD).

| # | Step (from §6) | Free tool / approach | Boundary |
|---|---|---|---|
| 1 | **Intake** — image, refs, text, colors, sport, notes → job manifest | JourneyAX chat + Mongo job manifest (§12); R2/GCS asset folder | **[AUTO-FREE]** — JourneyAX already does intake |
| 2 | **Style selection** — confirm real UA style + sizes | Chat + style registry (FR-03); reuse configurator style picker | **[AUTO-FREE]** |
| 3 | **Template load** — cut/sew/bleed/notch/piece-ID per size | Cut-piece registry (§8) read via **ezdxf**; Seamly2D for graded geometry | **[AUTO-w/REGISTRY]** — needs the registry populated per style/size |
| 4 | **Artwork decomposition** — separate bg / logo / text / numbers / sleeve art | **ComfyUI segmentation + masking**; classify assets (FR-02); composite logos/text as layers | **[AUTO-FREE]** for separation; **[ARTIST]** to confirm |
| 5 | **Master placement** — design on a canonical garment surface / normalized 2D map | Texture the approved art onto the garment's **UV layout** (Three.js/Blender) | **[AUTO-w/REGISTRY]** — depends on UV↔cut-piece match (step 6 gate) |
| 6 | **Cut-piece projection** — clip/project art into each size piece **with bleed** | If **UV islands == cut pieces**: texture in UV space *is* the per-panel print file. ezdxf writes bleed/cut/sew per panel; per-graded-size re-projection | **⚠ THE GATE.** **[AUTO-w/REGISTRY]** *only if UV==cut-piece*; else **[ARTIST]**/paid CAD |
| 7 | **Illustrator generation** — layered file, locked technical layers | **Inkscape** → layered **SVG 1.1** matching §9 layer names; place raster art + traced logos/text | **[AUTO-FREE]** to generate; **[ARTIST]** owns the file |
| 8 | **3D rendering** — same *production* artwork on the 3D garment | **Three.js** (live web proof, already in stack) or **Blender** headless (batch render per size/colorway) | **[AUTO-FREE]** — free equivalent of Optitex/Browzwear render |
| 9 | **Artist review** — seams, placement, colors, production details | Human, in Illustrator/Inkscape | **[ARTIST]** — by design; this is the production authority |
| 10 | **Proof export** — customer proof PDF + production package | **Scribus/Ghostscript** PDF/X; link back to manifest | **[AUTO-FREE]** |

### 6.1 The UV-match gate (step 6) — the single most important finding
The requirement's §10 flag ("if UV map doesn't match cut-piece PDF → invalid for automation") is the pivot of the whole system, and the research explains *why*:

- In a **properly built cut-and-sew 3D garment**, each **UV island *is* a cut-piece pattern** — because CLO/Browzwear build the 3D by draping the *actual 2D patterns*, so UV edge = pattern edge = seam. The pattern is a *developable surface* (flattens without stretch), which is exactly the condition that makes a UV island a real cuttable panel.
- **If UV == cut pieces:** the texture you author in UV space *is* the per-panel print file; seam continuity in the render == seam continuity in production. → **automatable, for free** (Blender/Three.js UV math + ezdxf).
- **If UV is arbitrary** (auto-unwrapped for looks, sculpted OBJ, merged/rotated islands): you can render a pretty proof but **cannot explode it into manufacturable panels**. → **invalid for automation**; needs paid CAD or an artist.

**Consequence for Augusta:** the highest-leverage, do-this-first task is **Phase 0 in the doc** — verify, for ONE style in 3 sizes, that the existing 3D UV islands map 1:1 to the size-specific cut-piece PDFs. That single check decides whether steps 5–6 are free-automatable or artist-only. It's also Open Question #1 in §15. Everything else depends on it.

### 6.2 What is genuinely free-automatable vs not (summary)
- **Free-automatable now:** intake, style/size selection, conversational raster proof, asset decomposition/masking, logo/text compositing, layered SVG generation, 3D proof render, PDF/X export, DXF read/write, measurement-driven grading (Seamly2D).
- **Needs the registry first:** template load, master placement, per-size cut-piece projection.
- **Needs artist / paid CAD:** building/certifying the base garment whose **UV==graded cut pieces**; true art-to-cut-piece projection *from an assembled concept image*; guaranteed cross-seam alignment across a full graded run; final production sign-off. No free turnkey tool does these — they're algorithmic work you'd build on ezdxf+Blender, or buy (Optitex/Browzwear/CLO + a patternmaker).

---

## 7. Zero-cost infrastructure (the "not one penny" constraint)

A genuinely $0 pilot is realistic. Layer-by-layer, with the honest limits:

| Layer | Best free option | Free limit | Commercial OK? | The catch |
|---|---|---|---|---|
| **AI image edit (primary)** | **Gemini `gemini-2.5-flash-image` (nano-banana)** | **500 req/day, 10 RPM** per project | **Yes** (Google grants ownership) | **Visible "Gemini" watermark on free tier** + invisible SynthID; quotas cut 50–80% in Dec 2025. 10 RPM is the real ceiling. |
| **AI image (edge fallback)** | **Cloudflare Workers AI** (FLUX schnell/klein) | 10,000 Neurons/day ≈ ~2k small gens | Yes | Budget shared across all AI calls; 1024px burns it fast. No watermark. |
| **AI image (open, commercial)** | **Qwen-Image-Edit self-host** (Apache-2.0) | Your GPU | **Yes** | Needs a GPU; free GPU (HF ZeroGPU ~3.5 min/day, Kaggle ~30 GPU-hr/wk) is demo-only, not production. |
| **Frontend host** | **Cloudflare Pages** | Unlimited bandwidth, 500 builds/mo | **Yes** | 10 ms CPU/req — heavy SSR moves to Workers/Cloud Run. **Avoid Vercel Hobby — non-commercial ToS.** |
| **Backend / orchestrator** | **Google Cloud Run** (scale-to-zero) | 180k vCPU-s + 2M req/mo | Yes | **Cold start 1–3 s** hurts "instant" UX; `min-instances=1` fixes it but starts billing. |
| **Object storage (images)** | **Cloudflare R2** | 10 GB, **$0 egress** | Yes | Egress-free is the killer feature for serving user images. |
| **Job manifests / state** | **MongoDB Atlas M0** (already used) | 512 MB, free forever | Yes | Metadata only, not blobs. |
| **Relational/auth (if needed)** | Neon Postgres | 0.5 GB, 100 compute-hr/mo | Yes | Scale-to-zero adds ~300–500 ms first-query latency. |
| **Background jobs** (vectorize/PDF/3D) | **Cloud Run Jobs** + **Cloudflare Queues** | Same compute pool; Queues 10k ops/day | Yes | Queue retention 24 h on free — design idempotent short jobs. GitHub Actions (2k min/mo) for batch. |

**Recommended fully-free reference architecture (low-volume pilot):**
Cloudflare Pages (SPA) → Cloud Run (chat orchestrator + MCP tools) → **nano-banana** primary edit model (+ Workers-AI FLUX fallback) → **R2** for assets + **Mongo M0** for manifests → **Cloud Run Jobs + CF Queues** for vectorize/PDF/3D. **Net recurring: $0**, no card required except to lift caps.

**Where it first costs money (be honest with the client):**
1. **Gemini 500/day + visible watermark** — fine for a pilot, *not* for a paid commercial product; that alone pushes to the paid Gemini API (~fractions of a cent/image, removes watermark).
2. **Cloud Run cold start** — sub-second UX at sporadic traffic needs `min-instances=1` (~a few $/mo).
3. **Free GPU never scales** — first real self-hosted-model need = HF PRO ($9/mo) or per-second GPU (Fal/Replicate/Modal).
4. **Non-commercial license traps** — **FLUX.1 Kontext [dev] and Vercel Hobby are both non-commercial.** Use **Qwen-Image-Edit (Apache-2.0)** and **Cloudflare Pages** instead.

---

## 8. The honest risk register

| Risk | Reality | Mitigation |
|---|---|---|
| "AI turns a picture into a factory file" expectation | False; no free (or reliable paid) tool does this. Every vendor is artist-in-loop. | Frame as **proof studio + structured hand-off**; keep the artist as authority (matches the doc). |
| Raster proof mistaken for production art | AI text ≠ real fonts; screen effects don't press; no vector/geometry. | Hard **"approve → convert"** boundary; composite real logos/fonts; §5 pipeline. |
| Size grading by image-scale | Breaks seams + placement across the run. | Anchor rules + per-graded-size geometry (Seamly2D + registry). |
| **UV ≠ cut-piece** | Makes steps 5–6 non-automatable. | **Phase-0 UV↔cut-piece audit on one style first** (Open Q#1). |
| Free-tier watermark / license | nano-banana free = visible watermark; FLUX-dev/Vercel Hobby = non-commercial. | Qwen (Apache-2.0) for commercial self-host; budget for paid Gemini at launch; Cloudflare not Vercel. |
| Cold-start latency vs "seconds" UX | Cloud Run 1–3 s; free GPU queues. | Small containers, `min-instances=1` at launch, nano-banana (no infra) for the interactive path. |
| No Pantone / no native `.ai` in free stack | Color-matching + Illustrator round-trip gaps. | Confirm printer color workflow (Open Q#7); hand off layered SVG/PDF, artist finishes in Illustrator. |

---

## 9. What the research recommends (synthesis, not a rebuild)

You said you already know the solution — so this is the research's verdict on **the best available path**, framed against your own MVP phases (§13):

- **Phase 0 (do first, cheap, decisive):** the **UV↔cut-piece audit** on one Under Armour style, 3 sizes. This single result determines whether the automation dream is free-reachable or artist-bound. It's also Open Questions #1, #2, #4, #8 answered in one exercise.
- **Phase 1 (the JourneyAX magic, free):** the **conversational proof studio** — 40/60 chat, upload concept, edit by talking (nano-banana + masked inpainting + logo/text compositing), live Three.js 3D proof. This is the demoable, high-wow, zero-cost piece and it's mostly muscle JourneyAX already has.
- **Phase 2 (structured hand-off, free tools):** **"approve → convert"** → Inkscape layered SVG (§9 layers) + traced logos (potrace/VTracer) + placed raster + Scribus/Ghostscript PDF/X + ezdxf cut-piece geometry → **artist finishes**.
- **Phase 3 (scale later):** if volume justifies it, revisit Browzwear VStitcher API (real automation) and paid Gemini/GPU — by then the registry + UV mapping are proven and the spend is justified.

**The market gap you'd be filling:** nobody today does *pure conversational, region-accurate, logo-safe editing of a customer's uploaded jersey image, connected to real cut pieces, for free.* PROLOOK proves the demand and the human-in-loop shape; JourneyAX's conversational engine + Augusta's cut-piece registry is a credible way to be *more connected and more conversational* than the incumbent — without spending a penny to prove it.

---

## Appendix A — Source URLs (by research stream)

**Conversational AI image editing:** felloai.com/is-nano-banana-free · aifreeapi.com/en/posts/gemini-image-generation-free-api · bfl.ai/blog/flux-1-kontext-dev · huggingface.co/black-forest-labs/FLUX.1-Kontext-dev · github.com/QwenLM/Qwen-Image · fal.ai/models/fal-ai/bytedance/seedream/v4/edit · apatero.com/blog/comfyui-inpainting-advanced-techniques-guide-2026 · aivario.com/tools/ideogram · prolook.com/pro-ai · pulsemerch.com/why-ai-generated-logos-dont-always-print-well

**Raster→vector + print PDF (free):** github.com/visioncortex/vtracer · en.wikipedia.org/wiki/Potrace · inkscape.org · wiki.scribus.net/canvas/Color_Management_setup · klaasnotfound.com/2016/06/05/creating-cmyk-prepress-pdfs-with-inkscape-and-scribus · ghostscript.readthedocs.io/en/latest/GhostscriptColorManagement.html · github.com/mozman/ezdxf · quicktransfers.com/blogs/dtf/how-to-create-and-prepare-artwork-for-sublimation-printing · vectorizer.ai/pricing · sudomock.com/blog/adobe-firefly-api-pricing-2026

**Cut-piece / pattern / 3D / competitors:** printful.com/blog/how-to-make-custom-all-over-print-shirts · printify.com/blog/cut-sew-vs-sublimated-shirts · taas.nyc/blog/dxf-files-for-3d-clothing-creation · standards.iteh.ai (ASTM D6673-10) · github.com/FashionFreedom/Seamly2D · ezdxf.readthedocs.io · docs.pictofit.com/content-service/latest/clo3d-guide · prolook.com/pro-ai · optitex.com/products/3d-design-for-illustrator · browzwear.com/api · support.clo3d.com/hc/en-us/articles/115012380628-Import-DXF · threejs.org/docs/pages/Texture.html · docs.blender.org/manual/en/latest/render/cycles/baking.html

**Zero-cost infrastructure:** ai.google.dev/gemini-api/docs/rate-limits · aifreeapi.com/en/posts/nano-banana-pro-watermark-commercial-use · huggingface.co/docs/hub/spaces-zerogpu · developers.cloudflare.com/workers-ai/models · cloud.google.com/run/pricing · deploywise.dev/blog/vercel-free-tier-limits-2026 · eastondev.com/blog/en/posts/dev/20260526-cloudflare-free-limits · r2drop.com/blog/cloudflare-r2-free-tier-guide · mongodb.com/docs/atlas/reference/free-shared-limitations · developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan

---

## Appendix R — Complete requirement (attached verbatim)

*Source: `Augusta_UA_AI_Cut_Piece_Requirements.docx`, v1.0, August 2026. Reproduced here so this research is self-contained.*

> **Augusta / Under Armour AI-to-Cut-Piece Artwork — Detailed Product Requirements, Market Research, and MVP Plan.** Prepared for JourneyAX jersey builder and CDL production workflow. Reference example: AI-generated customer artwork translated into production-ready jersey artwork.
>
> **1. Executive Summary.** The core requirement is to build a production translation layer for custom jersey artwork. Customers may create AI concepts outside Augusta (ChatGPT or another AI design tool) and upload those ideas. JourneyAX should translate the concept into the actual Under Armour garment cut-piece workflow: style- and size-specific PDF cut pieces, Adobe Illustrator editable artwork, live 3D preview, and customer proof generation. This release should not be positioned as replacing artists or guaranteeing artist-time reduction. The artist remains the production authority. Objective: give artists a structured, editable, cut-piece-based starting point that connects the customer concept to real manufacturable garment geometry. *Themes:* customer concept intake; cut-piece mapping; Adobe output (locked technical + editable art layers); live 3D proof; artist-in-loop validation; future optimization (not a first-round metric).
>
> **2. Business Context & Problem.** AI artwork is common in custom sportswear; customers bring flattened images that look like real jerseys but lack production intelligence (cut-piece geometry, size grading, seam continuity, printer color setup, editable logo layers). The current builder works for predefined designs/decoration locations. Custom Design Lines (CDL) differ: logos, text, numbers, stripes, full-body artwork may go anywhere. A flattened AI image must become manufacturable front, back, sleeve, collar, insert pieces. The proof must represent what can actually be printed, cut, stitched, shipped.
>
> **3. Current-Round Objective.** Build the bridge between customer AI artwork and the existing production design environment. Inputs (AI image, real UA style, free-flow placement, production constraints) → translation (identify style/pieces/regions/logos/text/placement; load style/size cut-piece templates; anchor to cut-piece coordinates; apply bleed/locked lines/validation) → outputs (editable Illustrator file, 3D proof, per-size artboards/files, artist-ready package). *One-line:* accept externally generated concepts and convert them into artist-editable, style- and size-specific Adobe Illustrator artwork by projecting the design onto actual UA garment cut pieces; render the same artwork on the corresponding 3D garment and generate a manufacturable proof for artist review.
>
> **4. Scope.** *In:* upload of AI concepts/refs/logos/prompts; one or more controlled UA styles in MVP; PDF cut-piece template ingestion + registry by style/size; free-flow placement of logos/numbers/text/full-garment art; editable Illustrator packages; live 3D preview; proof PDF; artist review/correction/release. *Out (this round):* fully automatic production without an artist; guaranteed artist-time reduction; all Augusta/UA styles immediately; automatic perfect vectorization of every photo/AI image; automatic final color approval for all printers/fabrics; replacing Illustrator or the 3D workflow.
>
> **5. Market Research Summary.** Pattern = AI concept intake + apparel pattern intelligence + Illustrator editing + 3D validation. Vendors: **PROLOOK PRO-AI** (concept in ChatGPT → upload → production-accurate proof; competitive benchmark); **Optitex 3D Design for Illustrator** (real-time 3D + print placement in Illustrator); **Adobe Illustrator API / Image Trace** (raster→vector for logos, not full cut-piece mapping); **CLO** (imports DXF-AAMA/ASTM; 2D/3D, UV, grading reference); **Browzwear VStitcher API** (garments/shapes/stitches/materials automation; future high-volume); **Vectorizer.AI** (raster→vector SVG/PDF/EPS/DXF utility); **Magnific/Freepik** (upscaling; optional prep).
>
> **6. Required End-to-End Workflow.** (1) Intake → job manifest + assets. (2) Style selection → style/size list + template refs. (3) Template load → cut/sew/bleed lines, notches, piece IDs. (4) Artwork decomposition → editable layers + asset classes. (5) Master placement → garment-surface design coordinates. (6) Cut-piece projection → clip/project into each size piece with bleed. (7) Illustrator generation → layered doc, locked technical layers. (8) 3D rendering → front/back/side proof. (9) Artist review → approved file. (10) Proof export → customer proof PDF + release package.
>
> **7. Functional Requirements.** FR-01 concept upload (JPG/PNG/PDF/SVG/AI/EPS + notes + prompt); FR-02 asset classification; FR-03 supported-style registry; FR-04 size-specific cut pieces (by brand/style/size/piece ID/template version/production method); FR-05 technical geometry (cut/sew/bleed lines, notches, orientation, seam adjacency, 3D mapping ref); FR-06 free-flow placement (CDL); FR-07 canonical garment-surface model; FR-08 **size generation without merely scaling the flattened image**; FR-09 logo anchoring (aspect + placement intent across sizes); FR-10 seam continuity (split/align across pieces, review flags); FR-11 Illustrator package (locked technical + editable art/text/logo layers); FR-12 3D preview of same artwork; FR-13 proof PDF (linked to package + manifest); FR-14 artist override of any placement/layer/asset/output.
>
> **8. Cut-Piece Template Registry** (critical foundation). Fields: brand; style ID; size; piece ID (front/back/sleeves/collar/gusset/insert…); cut outline; sew line; bleed line; notches & drill marks; orientation/grain; adjacent pieces; anchor points (chest center, sleeve center, shoulder, side seam, waist…); 3D mapping reference (UV island/mesh ID); template version (tied to physical pattern).
>
> **9. Illustrator Output.** Working production file, not a screenshot. Layers: `01_TECHNICAL_DO_NOT_EDIT` (cut/sew/bleed lines, notches, piece IDs); `02_BACKGROUND_ART`; `03_LOGOS`; `04_TEXT_AND_NUMBERS`; `05_ARTIST_ADJUSTMENTS`; `06_3D_MAPPING`; `07_PROOF_NOTES`. Technical layers locked by default; art layers editable; each size a separate artboard/document/approved grouped layout; linked assets packaged/embedded to standard; supports artist edits + 3D proof refresh.
>
> **10. 3D Rendering.** 3D model, cut-piece geometry, and Illustrator template must share style/size/template version. Proof rendered from **production artwork, not the original concept image**. Artist inspects front/back/side/sleeve/seam; preview multiple sizes when selected. **If the 3D UV map does not match the cut-piece PDF, flag the template as invalid for automation.**
>
> **11. Production-Readiness Validation.** Template completeness (all pieces/sizes/lines/notches); artwork coverage (no blanks/missing bleed/clipped logos/crops); asset integrity (links present, originals packaged, vectors retained); logo/text quality (readable, correct aspect, editable/approved outlines); color readiness (approved palette/profile or flagged); 3D consistency (from same production artwork/version); export readiness (proof PDF + package with approved presets).
>
> **12. Data Model: Job Manifest.** Job (jobId, customerId, channel, createdBy, status, due); Product (brand, styleId, sport, garment type, fit, production method); Sizes (selected, quantities, template version per size); Assets (concept image, logos, prompt, refs, source class); Artwork elements (elementId, type, source, layer, anchor, transform, dimensions, size behavior); Cut pieces (pieceId, size, cut/sew/bleed paths, UV mapping ID); Output (Illustrator file, proof PDF, renders, warnings, artist notes).
>
> **13. MVP Plan.** *Phase 0* — discovery + template validation (one style, 3 sizes, one production file, registry draft, mapping feasibility). *Phase 1* — artist-assisted POC (upload, template load, master placement, cut-piece clipping, Illustrator layers, proof render). *Phase 2* — size + seam intelligence (full size range, anchor rules, seam adjacency, bleed automation, warnings). *Phase 3* — customer JourneyAX experience (chat intake, style recommendation, mock-up request API, design history).
>
> **14. POC Acceptance.** Upload a Rink Rippers-style concept; artist selects a supported UA style; system loads S/M/L cut-piece templates; design positioned freely across front/back/sleeves; central logo separately editable from background; art crossing ≥1 seam split + reviewed; layered Illustrator doc generated; each size has complete artwork + bleed; existing 3D renderer shows the same artwork; artist edits the file + regenerates the proof; proof PDF exported; artist confirms usable for production. **No artist-time reduction required for POC.**
>
> **15. Open Questions for Augusta/Production.** UV islands map exactly to size-specific PDF cut pieces? Preferred source-of-truth format (PDF/AI/DXF-AAMA/DXF-ASTM/other)? First MVP style? How are cut/sew/bleed lines named today? Approved production PDF export presets? Required raster resolution for sublimation? Color/printer profile for MVP? Which Illustrator plug-in/script powers the current 3D preview? How are size patterns graded + version-controlled? Must-have proof views for approval?
>
> **Appendix A (research sources).** PROLOOK PRO-AI (prolook.com/pro-ai); Optitex 3D for Illustrator; Adobe Illustrator API Image Trace; Adobe Illustrator import PDF; CLO import DXF; Browzwear VStitcher API; Vectorizer.AI API; Magnific Image Upscaler API.
