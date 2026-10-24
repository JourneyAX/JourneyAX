# PlaceMakers Business Policy "TO CONFIRM" Audit List

This document lists all pending operational, pricing, and business policy confirmation placeholders identified during agent pack authoring. Each placeholder is preserved as neutral text in the published business pack so the runtime never halts, while awaiting formal sign-off from PlaceMakers commercial stakeholders.

---

## 1. Commercial Scope Boundaries (`profile.sellingScope.outOfScope`)

| Field | Placeholder Text in Pack | Stakeholder Question / Action Required | Neutral Fallback Behavior |
|---|---|---|---|
| `sellingScope.outOfScope[6]` | `Commercial tilt-slab concrete and pre-cast structural steel fabrication` | Does PlaceMakers supply commercial tilt-slab / pre-cast steel via frame & truss plants, or is it strictly out-of-scope for digital chat? | Advise customer to contact their branch trade account manager for specialized commercial fabrication. |
| `sellingScope.outOfScope[7]` | `Hire equipment / machinery rentals (or confirm if handled via branch partner)` | Does PlaceMakers offer tool & machinery hire directly or via third-party equipment partners? | Direct customers to branch staff for machinery hire inquiries. |

---

## 2. Customer Escalation & Handoff Channels (`handoffPolicy.hotTransferChannels`)

| Field | Placeholder Text in Pack | Stakeholder Question / Action Required | Neutral Fallback Behavior |
|---|---|---|---|
| `handoffPolicy.hotTransferChannels[0]` | `Phone transfer to 0800 PLACEMAKERS vs local branch DID` | Should phone escalations route to national customer support (0800 752 236) or directly to the customer's home branch phone number? | Provide branch lookup and national customer care contact. |
| `handoffPolicy.hotTransferChannels[1]` | `Web chat agent queue via Salesforce Service Cloud or Activepieces` | Which live agent routing queue is active for human chat takeover (Salesforce Service Cloud Omni-Channel vs internal queue)? | Queue turn to standard human handoff outbox event. |

---

## 3. Financial Approval & Spending Limits (`approvalPolicy`)

| Field | Placeholder Text in Pack | Stakeholder Question / Action Required | Neutral Fallback Behavior |
|---|---|---|---|
| `approvalPolicy.quoteThresholdComment` | `Default $10,000 NZD threshold before trade quote requires Branch Manager sign-off` | What is the exact automated quote threshold (currently defaulted to $10,000 NZD / 1,000,000 cents)? | Quotes above $10,000 NZD are created in `pending_approval` state requiring branch sign-off. |
| `approvalPolicy.discountThresholdComment` | `Any line discount exceeding customer tier standard margin requires review` | What is the maximum discretionary line discount permitted before requiring Branch Manager approval? | Any custom discount override triggers approval requirement. |

---

## 4. Pending Business Policy Questions (`businessQuestionsPendingConfirmation`)

1. **Q1 (Customer Pricing Tiers)**: What are the exact customer pricing tiers (e.g. Retail, Trade Club, Managed Account, Tier 1 Commercial)?
2. **Q2 (Approval Threshold)**: What is the authoritative maximum NZD threshold for automated quote generation before requiring branch manager approval?
3. **Q3 (Quote Validity Duration)**: What is the standard quote validity duration for timber and building materials (14, 30, or 60 days)?
4. **Q4 (Delivery Pricing & Schedules)**: What are the confirmed delivery pricing schedules (standard ute vs hiab crane truck) and branch delivery radius?
5. **Q5 (Return & Restocking Policy)**: What is the official return and restocking policy for standard vs custom cut-to-length framing?
6. **Q6 (Restricted Categories)**: Are there specific hazardous or restricted product categories that must be excluded from digital self-service?
7. **Q7 (Warranty Source of Truth)**: Which source system acts as the single source of truth for manufacturer warranty terms (SAP ERP vs PIM)?
8. **Q8 (Customer Escalations Channel)**: What is the preferred contact channel for customer escalations (national 0800 vs direct branch routing)?

---

## 5. Author Worklist: Pack & OKF Glossary Additions (U3)

The following glossary aliases and customer phrases are identified from customer search lookup evaluation for PlaceMakers pack authors to incorporate into the business pack / OKF authoring proposal:

| Target Concept / Category | Customer Search Phrase | Catalogue Reality / Feed Equivalent | Author Action Required |
|---|---|---|---|
| `Building Hardware > Brackets` | `pergola brackets` | `Post Bracket`, `Post & Bearer Bracket`, `Joist Hanger` | Add alias cluster linking pergola framing hardware to post/bearer brackets. |
| `Tapware & Showering` | `outdoor taps`, `outdoor tap plumbing` | `Angle Hose Tap`, `Hose Tap Long Handle`, `Bib Tap` | Add alias cluster linking outdoor taps to hose taps and bib taps. |
| `Roofing > Polycarb Roofing` | `translucent roofing` | `Corrugated Roofing Sheet`, `PVC Light Blue`, `SunTuf Clear` | Add alias cluster linking translucent roofing to polycarbonate and PVC corrugated roofing. |
| `Bathroom Accessories` | `bathroom accessories`, `bathroom fixtures` | `Towel Rail`, `Toilet Roll Holder`, `Soap Dish` | Add alias cluster mapping customer plural phrase to category items. |
| `Fencing & Decking > Posts` | `fence posts` | `Rough Sawn Fence Post H4`, `Glulam Post H5` | Add plural alias in pack vocabulary synonyms. |
| `Fencing & Decking > Fence Panels` | `aluminium fence panels` | `Mansion Fence Panel ... Aluminium`, `Delta Aluminium Fence Panel` | Add multi-word alias linking material + product type. |
| `Fencing & Decking > Fence Trellis & Panels` | `fence trellis panel` | `Radiata Trellis Fencetop`, `Trellis Double Oriental` | Add alias cluster linking trellis panel requests to trellis fencetops. |
| `Paint & Decorating > Aerosol Paint` | `aerosol paint`, `spray paint for metal` | `Killrust Aerosol Spray Paint`, `Cold Galvit` | Add alias mapping spray paint to aerosol paint category. |
| `Insulation > Fibreglass` | `Pink Batts` | Brand `Pink® Batts®` / `Pink Batts` | Ensure brand name is cross-referenced in pack insulation concept aliases. |
| `Outdoor & Landscaping > Clotheslines` | `clothesline`, `outdoor clotheslines` | `Compact Fold Down Clothesline`, `Rotary Clothesline` | Add alias linking clotheslines to rotary and fold-down lines. |

---

## 6. Night-2 additions (2026-10-24): settings the owner should confirm

These are pack data (`extensions.quantityHelper`, `extensions.visualiser`, `skills`) set by Claude Code on the owner's "everything approved" instruction. None is a fact about the business; each is a default to confirm or change.

| Setting | Value now | What to confirm |
|---|---|---|
| Allowance for cuts and waste added to a worked-out quantity | 10% | The percentage PlaceMakers actually recommends, per product kind if it differs (paving, tiles, boards, paint). |
| Paint and coverage | none stated in the data except a few primers ("offers 10 m-sq coverage") | Real coverage per litre and coats per product kind. Until then the consultant asks the customer to read the coverage off the tin and says the record does not state it. |
| Pictures of the finished job | on, model `gpt-image-1.5`, quality low, labelled "An illustration made for you, not the exact product." | Whether PlaceMakers wants customers to see AI illustrations at all, and the exact label wording. Cost: one image per request. |
| Accessories | from the knowledge's 30 "goes with" links (interior paint, deck build, drills, screws, toilets, vanities and a few more); everything else is "suggestions to check" found by search | Real accessory lists per shelf (paving: sand, edging, adhesive; exterior paint; decking fixings) so every shelf has verified groups. |
| Colour choices | read from the last words of sibling product names (e.g. "Glacier", "Volcanic Ash"); the data has no colour chart or swatches | A colour chart (names and hex values) for paint and for pavers if real swatches should be shown. |
