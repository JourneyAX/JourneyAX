# Cap Configurator — Analysis and Implementation Plan

> **Analysis date:** 20 July 2026
> **Verified against:** `https://www.momentecbrands.com/CapConfigurator?...&partNumber=P414&capColorCode=E64`
> **Status:** C1–C4 shipped and browser-verified (20 July 2026). C5–C6 outstanding.
> Every claim below was tested live.
>
> **Shipped:** garment type derived from the catalogue category (125 headwear styles, so
> Headwear is now a rack group); `cap-decoration` capture stage run through the ingest API
> (100 configurable, 25 stock-only, 0 failed); `decorationSystem` drives designability without
> reopening AUG-25; cap render branch + per-mesh client-side colouring. `P414` verified
> rendering in NAVY/WHITE in the live journey.
>
> **Correction to §5 below:** `CapStyles.json` lists 35 styles, but `getColorConfig` serves
> colourways for 100 — that file understates coverage and must not be used as the gate.
> **Companion:** the user's research document `augusta_cap_configurator_deepdive.md` — mostly accurate; four corrections are recorded in §2.

---

## 1. What a cap actually is, in this platform's terms

```
identity     P414 "Weekender Unstructured Snapback Cap" · $13.50 · brand: Pacific Headwear
variance     6 colours × One Size · live stock 669–1,750 per variant
3D           3D/P414.glb · 12.5 MB · 15 meshes · Three.js r133 GLTF + Draco
colour       getColorConfig → per-mesh hex, applied CLIENT-SIDE
decoration   4 zones (front/back/left/right), technique-priced
lead time    priceAndLeadTime — shared with jerseys
```

**Caps are not a separate product line and this is not a separate build.** They are the same
Momentec/Augusta catalogue, and the rack already carries tops, bottoms and accessories. A cap belongs
beside the jersey it matches: ask for a baseball kit and the relevant cap should surface with it.

The journey is identical — designs, logos, names, printing. Only the *configuration mechanism*
differs. Everything below is therefore an **extension of the existing rack and journey**, not a
parallel system. Any phase that would produce a separate cap flow is wrong by construction.

### The one structural difference that matters

| | Jersey | Cap |
|---|---|---|
| Colour applied | **server-side** — Scene7 composes a texture atlas | **client-side** — Three.js mutates each mesh's material |
| We fetch | a composed PNG | a hex map + a mesh |
| Choice space | design line × colour × 7 sizes | colour × One Size |
| Stock | not exposed | **live per-variant quantity** |

Everything else — kit, roster, quote, artwork approval — is unchanged.

---

## 2. Corrections to the research document

The document is a good map and saved real time. Four claims failed live and would have caused rework:

1. **Pricing and inventory are NOT authenticated.** Both are public:
   `priceAndLeadTime/getPriceAndLeadTime` and `asgIntInventory/getInventory`.
2. **`104C` is absent from `CapStyles.json`** — the document's own headline example. 12 of its other 13 entries verified exactly.
3. **Mesh names are per style, not universal.** The doc's table is `104C`-specific:
   `104C: mesh_cap_crown_front, crown_stitches, visor_stitches`
   `P414: mesh_cap_crown, crown_stitch, visor_stitch` + `crown_back_logo`, `visor_inner_border`
   This is the same trap as jersey design lines (AUG-23) and text slots (AUG-30): **read per style, never default.**
4. **APIs are spread across 14 service families**, not concentrated under `savecapconfiguration`.

### Also found, not in the document

- **`getMeshSizeJSON()` is an empty stub** and `directory` is never assigned. The compressed path is therefore dead code — `P414` 403s on `3D-Compressed/` and loads from `3D/`. The 13 KB compressed models exist but the live app appears never to use them. **Unverified assumption:** that they are usable. Confirm with a network capture before relying on it — it is a ~1000× size difference (13 KB vs 12.5 MB) and worth the check.
- **Caps are Pacific Headwear**, a different brand from Augusta. Likely why cap SKUs return nothing from Augusta's `productview/byPartNumber` while sitting in the CSV feed.
- **127 cap-like products are already ingested**, with prices and variants.

---

## 3. The blocking defect

`P414` is stored with `isSublimation: false`. AUG-25 uses exactly that field to decide a style is **not designable** — the fix that stopped the agent offering stock jerseys for custom kits.

**So today the agent will refuse to design any cap**, on the grounds that it is a stock garment. It is not: it is customisable through a different system.

This must be fixed first, and the fix must not reopen AUG-25. `isSublimation` conflates two different questions — *is this made-to-order?* and *which rendering system does it use?* Caps prove those are separable. The right answer is a capability derived per style (`decorationSystem: 'sublimation' | 'cap' | null`), with `isSublimation` no longer read as a proxy for designability.

---

## 4. Verified API surface

All public, all `GET`, all confirmed live.

| Purpose | Endpoint |
|---|---|
| Colour map per style | `/wcs/resources/store/{storeId}/savecapconfiguration/getColorConfig?responseFormat=json&rq={ts}&partNumber={SKU}` |
| Per-style render flags | `/wcsstore/ASGStorefrontAssetStore/Configurator-Cap/ConfiguratorSubsection/CapStyles.json` (35 styles) |
| Live stock | `/wcs/resources/store/{storeId}/asgIntInventory/getInventory?responseFormat=json&partNumber={SKU}` |
| Lead time + surcharges | `/wcs/resources/store/{storeId}/priceAndLeadTime/getPriceAndLeadTime?rq={ts}` (2,311 rules) |
| 3D mesh | `https://static.momentecbrands.com/3D/{SKU}.glb` |
| Texture (special colours) | `https://static.momentecbrands.com/texture/{SKU}_{colorCode}_Texture.png` — **403 externally, needs the asset proxy** |

**Every one of these belongs in project config**, alongside `colourCollections` / `imagingHost` / `texturePattern` from AUG-30. No endpoint literal in code.

### Data shapes

```
getColorConfig → { colorJson: { "E64": "{\"mesh_cap_crown\":\"fefefe\", …}" } }
                  values are JSON STRINGS, not objects — parse each

getInventory   → [ { partNumber:"P414.E64.OS", quantity:"975", itemStatus:20, skuId } ]
                  SKU shape: {style}.{colorCode}.{size}

decoration     → getDeorationSku(side, position, technique, variant)
                  key "FRONT_FRONT_DIGITALPRINT" → decorSKUMap → spDecorationPricingJson
```

---

## 5. Where this fits — reuse, don't rebuild

`ConfiguratorPort` already exists (`packages/integration/src/ports.ts:134`). Caps are a **second implementation**, not a parallel system.

Reused unchanged:
- **Kit rack** (AUG-31) — already groups by garment type; a cap hangs beside a top and bottom
- **Quote engine** (P0-04) — authoritative for money; cap price + decoration surcharge go through it, never summed client-side
- **Team colours** (AUG-27) — a school's colours map onto cap colour codes the same way
- **Artwork approval** (AUG-16) — customer-supplied marks, unchanged
- **Asset proxy** (AUG-29) — already host-allowlisted; add the texture CDN host
- **Three.js viewer** — the panel already runs GLTFLoader client-side, so the cap's client-side colouring is *closer* to what the panel does than the jersey's server-composed atlas

New and cap-specific: Draco decoder, per-mesh hex application, and live inventory.

---

## 6. Phased plan

Each phase ships and is verified before the next. Same discipline as AUG-30/42: **sample first, then bulk.**

### C1 — Designability (blocking)
Stop `isSublimation:false` meaning "cannot be designed". Derive `decorationSystem` per style; caps become designable without reopening AUG-25.
*Verify:* the agent offers a cap for "caps for our team" and does not refuse it.

### C2 — Cap capture stage
A pipeline stage — config-driven, run through the ingest API, never a script — capturing per style: colour codes, per-mesh hex maps, mesh inventory from the GLB, `CapStyles.json` flags, live stock.
*Verify:* sample 3 caps by hand before bulk. Log unresolved values loudly, as AUG-30 does.

### C3 — Cap render adapter
`ConfiguratorPort` implementation. Returns mesh URL + per-mesh colour map instead of a texture URL. The panel branches on the port, not on a hardcoded brand.
*Verify:* `P414` in `E64` renders and matches the live site.

### C4 — Cap in the journey (extension, not a new flow)
The cap surfaces in the SAME journey: asked for a baseball kit, the matching cap appears alongside
the top and bottom in the rack that already exists. Colour picker from real codes; stock surfaced
("975 in navy"); team colours map to cap colour codes.
*Verify:* browser — school → colours → jersey AND cap in one kit, no separate cap journey.

### C5 — Decoration  *(structure + lead time shipped; per-technique pricing deferred)*
Decoration for a cap is a customer logo/patch on a side (front/back/left/right),
by technique (embroidered, woven, silicone, sublimated, faux leather, patch),
each technique with its own lead time — verified live from the cap configurator's
`leadTimeForDecorablePTCH_*` constants. **Shipped:** the sides + techniques + their
lead times live in project config (`websphere-rest.capDecoration`, editable in the
back office, not hardcoded), and are surfaced in cap knowledge and on each cap doc.
Decoration is priced as an authoritative quote line through the EXISTING pricebook —
so money stays server-owned (P0-04); nothing is invented.
**Deferred (filed):** the technique→decoration-SKU price map only materialises after
driving the live art-upload flow (upload → pick technique → the page then loads the
SKU/pricing), so per-technique decoration PRICES are not yet captured. Until then a
decoration line is "price on request", never a fabricated number.
*Verify:* cap knowledge states the decoration options; a decoration SKU, once known,
prices through the quote engine like any garment.

### C6 — Lead time (benefits jerseys too)  *(shipped)*
Ingested `priceAndLeadTime` as a config-driven `lead-time` stage. The feed mixes
per-style rush/reorder rules with per-productType windows; the standard production
window is `MinimumDays_LeadTime_{productType}` (CUT_SEW 15, TURBO 5, REVERSIBLE 15,
CCM 50…), joined on the product type the catalogue already records (REGULAR→CUT_SEW;
caps→CUT_SEW). 518 products tagged. The pricebook returns `leadTimeDays`; the quote
engine computes the ORDER window as the max across made-to-order lines, server-side,
with a narrative summary rendered in the quote panel. Knowledge mentions it too.
*Verified:* a cap (15d) + a TURBO jersey (5d) → order window 15 business days.

---

## 7. Open questions

1. **Are the 13 KB compressed models usable?** Worth a network capture — 1000× smaller.
2. **Cap colour codes vs team colours.** Jerseys take a colour *name* per zone; caps take a *colour code* selecting a whole pre-authored hex map. A school's navy may have no exact cap code. The honest behaviour is to show nearest available and say so — never silently substitute, per AUG-27.
3. **Do caps have a roster?** `rosterdata/` is in the cap bundle, but caps are One Size — per-player naming may still apply.
4. **Custom caps** (per-component colour picking, `CROWN_080` key prefixes) — a later phase; needs its own verification.

---

## 8. Method note

Everything here was tested against the live site before being written down. That was deliberate: on the jersey work, three external documents asserted "confirmed" facts that failed on first request, and the cost was rework each time. The four corrections in §2 are what that check bought.

Where something is inferred rather than tested it says so — §2's compressed-model assumption and every item in §7.
