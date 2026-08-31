# Augusta CDL — Spec (simple, no jargon)

*Custom Design Line. This is the agreed flow, in plain terms. Companion docs (research, tools, Illustrator/Optitex reference): `augusta-cdl-*`, `augusta-*` in this folder.*

---

## The flow

1. **Customer uploads the design.**
2. **Analyze the design** — understand the design, the pattern, the artwork, the logo, everything.
3. **Check our templates — is there a matching one, with all the sizes?**
   - **Yes →** take that template.
   - **No →** create the cut pieces (make the template) with the sizes.
4. **Apply the design** onto the template.
5. **Run it in 3D (Three.js)** — show the customer the real view (how they'll actually see it).
6. **Customer adjusts** — move the name / logo somewhere else if they want; tweak it per size.
7. **Export** — the editable file goes to **Adobe** (and **Firefly** if the artist needs to vectorize/edit the logo or change something).
8. **Artist reviews, customer agrees → send for printing.**

## The one fork

**Template exists with all sizes → use it.  Not there → create it.**
After the fork, **both go through the exact same steps** (apply design → 3D → customer adjusts → export → artist + customer approve → print).

```
Upload → Analyze → Check templates (all sizes?)
                        │ yes → use template ─┐
                        │ no  → create cut pieces + sizes ─┤
                                                           ▼
        Apply design → 3D live view → customer adjusts
              → export (Adobe / Firefly) → artist + customer agree → print
```

---

## What we build — 3 parts

### Part 1 — Analyze + Match  *(start here — it decides "use vs create")*
- **In:** the uploaded design image (+ any logo/assets).
- **Do:** understand it — garment type (hockey jersey, baseball jersey…), style/construction, the artwork, the logo, colours, elements.
- **Match:** turn that into a signature and look up the template library — is there a matching template **with all sizes**?
- **Out:** a matched template, **or** "not found → create."

### Part 2 — Create the Template  *(only when there's no match)*
- **Make the cut pieces** for that garment (the flat panels).
- **Grade to all sizes** (S/M/L/XL…).
- Register the zones / anchors (where logo, name, number go).
- **Validate on the 3D model.**
- Save it as a new template (so next time it's a match).

### Part 3 — The shared rest  *(same for both branches)*
- **Apply the design** onto the panels — per size, with bleed, seams matching.
- **Logo:** upload → **vectorize** → place.
- **Name / number / colours** → their slots and zones.
- **Live 3D proof (Three.js)** — the real view.
- **Customer adjusts** — move logo/name; tweak per size.
- **Export** the editable file → **Adobe Illustrator (Firefly Services)** — for the artist to vectorize/edit the logo or change anything.
- **Artist reviews + customer agrees.**
- **Send for printing.**

---

## What "template exists with all sizes" checks

The template library holds, per template:
- garment type + style
- the **sizes present** (must have *all* required sizes to count as a match)
- the cut pieces (panels)
- the zones / anchors (logo, name, number, colour areas)
- version

Match = same garment/style **and** all sizes present. Missing sizes = treat as "create."

---

## Tools (reference)

| Step | Tool |
|---|---|
| Analyze the design | AI vision (Gemini / similar) |
| Create cut pieces + grade | Seamly2D / Freesewing (parametric block) → per-size panels |
| Live 3D view | Three.js |
| Export / logo vectorize / edits | Adobe Illustrator API (Firefly Services) |
| Print files | our renderer (art + bleed) → marker / cutter |

---

## Start

**Step 1 — Analyze + Match.** Look at the upload, understand it, and decide **use vs create**. Everything else follows from that answer.
