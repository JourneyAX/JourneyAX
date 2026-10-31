# PlaceMakers OKF Coverage Audit Report (2026-10-23)

**Release Audited**: PlaceMakers OKF Release `okf-pm-authored` (v1.0.0)
**Source**: Published release fixture via `buildPlaceMakersStack()` (*loaded from test fixture as dev database is not connected in this local environment*).
**Dataset**: 100 PlaceMakers Test Prompts (`docs/evals/placemakers-100.json`).

## 1. Executive Summary

- **Total OKF Concepts in Release**: 476
- **Total OKF Relationships in Release**: 509
- **Authored Aliases/Glossary Entries**: 87
- **Authored Project Recipes**: 8
- **Authored Problem/Safety Concepts**: 6
- **Prompts Evaluated**: 100

### Identified Gaps Summary by Type

| Gap Type | Count | Description |
| --- | --- | --- |
| **Glossary** | 4 | Missing synonyms, trade colloquialisms ("jib", "dwang"), metric-imperial aliases, and invalid shorthand handling |
| **Project Recipes** | 4 | Structured multi-item bills of materials (retaining walls, cabinets, paving, fences) |
| **Product Family Notes** | 4 | Technical distinction notes (KD vs wet timber, treatment hazard grades H1.2-H4, paver vehicular loads, collated nail standards) |
| **Relationships** | 5 | "What goes with what" system compatibility links (plasterboard to screws/compound, deck joists to hangers/coach bolts, retaining timber to drain coil) |
| **Install / Care Notes** | 3 | Installation prerequisites, span guides (NZS 3604), hole drilling, surface prep, and application steps |
| **Safety & Compliance** | 2 | Electrical hazard precautions, retaining wall consent height limits, structural framing load limits |
| **Warranty** | 1 | Manufacturer warranty terms, treatment durability rules, and prerequisite installation conditions |

## 2. Work List for OKF Authors (Grouped by Type)

### A. Glossary Gaps
- [ ] **Glossary entry: "jib" -> GIB® plasterboard**
- [ ] **Graceful fallback for garbled queries: identify recognizable sub-tokens (cabinet, timber, 4x2) while acknowledging unclear text**
- [ ] **Invalid shorthand rejection/clarification note: 9x15 is not a valid timber dimension (clarify to 100x50 / 150x50 rail)**
- [ ] **Metric-imperial timber dimension mappings (4x2 = 100x50 / 90x45 finished)**

### B. Project Recipe Gaps
- [ ] **Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners**
- [ ] **Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails**
- [ ] **Paving installation recipe: GAP20 basecourse, sand bedding layer, paving stones, jointing sand**
- [ ] **Timber retaining wall recipe: H4 posts, H4 tongue-and-groove or rough sawn rails, scoria backfill, perforated drainage coil, filter sock**

### C. Product Family Note Gaps
- [ ] **Paslode collated nail compatibility: D-head vs round head, fuel cell vs gasless, 30-34 degree collation**
- [ ] **Paver thickness guide: 40-50mm for pedestrian footpaths vs 60-80mm interlocking for vehicular driveways**
- [ ] **Technical distinction between Kiln Dried (KD framing, stable, pre-shrunk) and Wet (rough sawn/retaining timber, shrinkage risk)**
- [ ] **Timber treatment hazard classes (H1.2 Boron internal, H3.2 CCA exterior above ground, H4 in ground contact)**

### D. Relationship Gaps (What Goes With What)
- [ ] **Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue**
- [ ] **Deck joists -> joist hangers, M12 coach screws/bolts, DPC barrier tape**
- [ ] **Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete**
- [ ] **Plasterboard -> 25mm/32mm drywall screws, joint compound, paper tape**
- [ ] **Retaining timber -> 12mm galvanised coach screws, perforated drain coil, geotextile fabric**

### E. Install & Care Note Gaps
- [ ] **Guidance on where wet timber cannot be used (enclosed framing) vs outdoor landscaping**
- [ ] **Masonry fastener installation: drill bit diameter must exactly match anchor sleeve diameter; blow dust out before inserting**
- [ ] **NZS 3604 joist span and spacing guide (e.g. 150x50 vs 190x45 for joist spans up to 2.4m at 400mm centres)**

### F. Safety & Compliance Gaps
- [ ] **Building consent threshold note: Retaining walls over 1.5m or supporting surcharge load require building consent and engineering**
- [ ] **Safety rule: Restrict fixing recommendations near hidden electrical wiring; require non-conductive inspection / stud finding**

### G. Warranty Gaps
- [ ] **Manufacturer warranty coverage: Composite decking (e.g. 15-25 year stain & fade warranty conditional on approved clip installation)**

## 3. Detailed Audit by Prompt (Sample & High-Priority Findings)

| ID | Prompt | Category | Applicable OKF Content | Identified OKF Gaps |
| --- | --- | --- | --- | --- |
| **#1** | Do you have 100x50 H3.2 treated timber in stock? | Timber & Dimensions | framing_timber -> Timber & Plywood > Structural Grade Timber Kiln Dried | Timber treatment hazard classes (H1.2 Boron internal, H3.2 CCA exterior above ground, H4 in ground contact) |
| **#2** | I need 4x2 timber for framing, what do you have? | Timber & Dimensions | framing_timber -> Timber & Plywood > Structural Grade Timber Kiln Dried | Fully covered by existing taxonomy |
| **#3** | What's the difference between kiln dried and wet timber? | Timber & Dimensions | None directly matched | Technical distinction between Kiln Dried (KD framing, stable, pre-shrunk) and Wet (rough sawn/retaining timber, shrinkage risk); Guidance on where wet timber cannot be used (enclosed framing) vs outdoor landscaping |
| **#4** | Looking for 150x50 treated pine for a deck frame | Timber & Dimensions | loo -> Toilets | Metric-imperial timber dimension mappings (4x2 = 100x50 / 90x45 finished); Deck joists -> joist hangers, M12 coach screws/bolts, DPC barrier tape; NZS 3604 joist span and spacing guide (e.g. 150x50 vs 190x45 for joist spans up to 2.4m at 400mm centres) |
| **#5** | Do you sell untreated structural timber? | Timber & Dimensions | None directly matched | Fully covered by existing taxonomy |
| **#6** | What size timber do I need for deck joists? | Timber & Dimensions | None directly matched | Deck joists -> joist hangers, M12 coach screws/bolts, DPC barrier tape; NZS 3604 joist span and spacing guide (e.g. 150x50 vs 190x45 for joist spans up to 2.4m at 400mm centres) |
| **#7** | 9x15 timber for a fence rail - do you stock that? | Timber & Dimensions | None directly matched | Invalid shorthand rejection/clarification note: 9x15 is not a valid timber dimension (clarify to 100x50 / 150x50 rail); Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#8** | Can I get H1.2 treated timber for interior framing? | Timber & Dimensions | None directly matched | Timber treatment hazard classes (H1.2 Boron internal, H3.2 CCA exterior above ground, H4 in ground contact) |
| **#9** | What's your cheapest 6x2 treated timber? | Timber & Dimensions | None directly matched | Fully covered by existing taxonomy |
| **#10** | Do you have square dressed boards for skirting? | Timber & Dimensions | skirting -> Square Dressed Boards & Mouldings | Fully covered by existing taxonomy |
| **#11** | I need timber for retaining wall sleepers | Timber & Dimensions | sleepers (product_category) | Timber retaining wall recipe: H4 posts, H4 tongue-and-groove or rough sawn rails, scoria backfill, perforated drainage coil, filter sock; Retaining timber -> 12mm galvanised coach screws, perforated drain coil, geotextile fabric; Building consent threshold note: Retaining walls over 1.5m or supporting surcharge load require building consent and engineering |
| **#12** | What plywood thickness is best for flooring underlay? | Timber & Dimensions | plywood (product_category); underlay (product_category); ply -> Timber & Plywood > Plywood | Fully covered by existing taxonomy |
| **#13** | Show me your range of decking timber | Timber & Dimensions | decking (product_category) | Fully covered by existing taxonomy |
| **#14** | Do you have 100x100 treated posts for a pergola? | Timber & Dimensions | posts (product_category) | Fully covered by existing taxonomy |
| **#15** | What timber grade should I use for load-bearing beams? | Timber & Dimensions | None directly matched | Fully covered by existing taxonomy |
| **#16** | I want to build a timber paling fence, what do I need? | Fencing & Decking | None directly matched | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#17** | What's the difference between palings and rails for fencing? | Fencing & Decking | None directly matched | Fully covered by existing taxonomy |
| **#18** | Do you have fence trellis panels in stock? | Fencing & Decking | None directly matched | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#19** | Looking for aluminium fence panels instead of timber | Fencing & Decking | fence panels (product_category); loo -> Toilets | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#20** | What's needed to build a basic backyard fence? | Fencing & Decking | None directly matched | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#21** | Show me composite decking options | Fencing & Decking | decking (product_category); composite decking (product_category) | Manufacturer warranty coverage: Composite decking (e.g. 15-25 year stain & fade warranty conditional on approved clip installation) |
| **#22** | What's needed to build a deck from scratch - framing, boards, fixings? | Fencing & Decking | project:deck_build (Deck build); deck_project_extras: project:deck_build -> Wood Screws, Woodcare, Outdoor Cleaners | Fully covered by existing taxonomy |
| **#23** | Do you sell pergola kits? | Fencing & Decking | None directly matched | Fully covered by existing taxonomy |
| **#24** | I need fence posts and concrete for a new boundary fence | Fencing & Decking | posts (product_category); fence posts (product_category) | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#25** | What's the best decking board width for a small patio? | Fencing & Decking | decking (product_category) | Fully covered by existing taxonomy |
| **#26** | Do you stock GIB plasterboard sheets? | Building Materials | plasterboard (product_category); gib -> Building Products > Plasterboard | Fully covered by existing taxonomy |
| **#27** | Find me a jib board | Building Materials | None directly matched | Glossary entry: "jib" -> GIB® plasterboard |
| **#28** | What insulation do you recommend for ceiling, R2.2 or R2.6? | Building Materials | insulation (product_category) | Fully covered by existing taxonomy |
| **#29** | I need underfloor insulation for an old villa | Building Materials | insulation (product_category); loo -> Toilets | Fully covered by existing taxonomy |
| **#30** | Do you have Pink Batts in stock? | Building Materials | pink_batts -> Building Products > Insulation | Fully covered by existing taxonomy |
| **#31** | What wet wall lining do you have for a bathroom? | Building Materials | project:wet_area_lining (Wet area lining); wet_area_lining_extras: project:wet_area_lining -> Waterproofing, Flashing & Sealing Tapes, Adhesives & Sealants > Adhesives & Sealants > Caulks And Sealants, Measuring Tools | Fully covered by existing taxonomy |
| **#32** | Looking for MDF panels for cabinetry | Building Materials | loo -> Toilets | Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners; Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue |
| **#33** | Do you sell roofing iron or steel roofing sheets? | Building Materials | roofing (product_category); roofing_iron -> Building Products > Roofing | Fully covered by existing taxonomy |
| **#34** | What's the R-value difference between wall and ceiling insulation? | Building Materials | insulation (product_category) | Fully covered by existing taxonomy |
| **#35** | I need concrete mix for a small footpath | Building Materials | None directly matched | Fully covered by existing taxonomy |
| **#36** | Do you have noticeboard or pinboard panels? | Building Materials | None directly matched | Fully covered by existing taxonomy |
| **#37** | What thickness plasterboard do I need for a garage wall? | Building Materials | plasterboard (product_category) | Fully covered by existing taxonomy |
| **#38** | What woodcare paint do you recommend for an outdoor deck? | Paint & Finishes | paint (product_category); woodcare (product_category) | Fully covered by existing taxonomy |
| **#39** | Do you have Resene paint in stock? | Paint & Finishes | paint (product_category) | Fully covered by existing taxonomy |
| **#40** | I want to build a pink colour cabinet from scratch, what paint? | Paint & Finishes | paint (product_category) | Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners; Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue |
| **#41** | What's a good stain blocker for water marks before painting? | Paint & Finishes | paint (product_category); undercoat -> Primers Sealers & Undercoats | Fully covered by existing taxonomy |
| **#42** | Do you sell aerosol/spray paint for small touch-ups? | Paint & Finishes | paint (product_category); spray_paint -> Aerosol Paint | Fully covered by existing taxonomy |
| **#43** | What finish is best for exterior timber cladding? | Paint & Finishes | cladding (department); timber cladding (product_category) | Fully covered by existing taxonomy |
| **#44** | Looking for a clear timber sealer for a deck | Paint & Finishes | undercoat -> Primers Sealers & Undercoats; loo -> Toilets | Fully covered by existing taxonomy |
| **#45** | Do you have exterior paint in a range of colours? | Paint & Finishes | paint (product_category); exterior paint (product_category) | Fully covered by existing taxonomy |
| **#46** | What primer should I use before painting new MDF? | Paint & Finishes | paint (product_category); undercoat -> Primers Sealers & Undercoats | Fully covered by existing taxonomy |
| **#47** | I need paint for a fence - what do you recommend? | Paint & Finishes | paint (product_category) | Fence build project recipe: H4 fence posts (100x100), H3.2 rails (100x50), palings, fast-setting concrete, galvanised nails; Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#48** | What screw should I use for wallboard? | Fixings & Fasteners | None directly matched | Plasterboard -> 25mm/32mm drywall screws, joint compound, paper tape |
| **#49** | Do you stock cladding screws in stainless steel? | Fixings & Fasteners | cladding (department); screws (product_family) | Fully covered by existing taxonomy |
| **#50** | What's the right screw size for decking boards? | Fixings & Fasteners | decking (product_category) | Fully covered by existing taxonomy |
| **#51** | I need nails for a Paslode nail gun | Fixings & Fasteners | nails (product_family); nail_gun -> Nailers/Bradders & Concrete Guns/Staplers | Paslode collated nail compatibility: D-head vs round head, fuel cell vs gasless, 30-34 degree collation |
| **#52** | Do you have brackets for a pergola build? | Fixings & Fasteners | None directly matched | Fully covered by existing taxonomy |
| **#53** | What fixings do I need for a timber retaining wall? | Fixings & Fasteners | timber retaining (product_category) | Timber retaining wall recipe: H4 posts, H4 tongue-and-groove or rough sawn rails, scoria backfill, perforated drainage coil, filter sock; Retaining timber -> 12mm galvanised coach screws, perforated drain coil, geotextile fabric; Building consent threshold note: Retaining walls over 1.5m or supporting surcharge load require building consent and engineering |
| **#54** | Looking for construction adhesive for skirting boards | Fixings & Fasteners | skirting -> Square Dressed Boards & Mouldings; liquid_nails -> Adhesives & Sealants > Adhesives & Sealants > Adhesives; loo -> Toilets | Fully covered by existing taxonomy |
| **#55** | What screws are safe to use near electrical wiring? | Fixings & Fasteners | electrical (product_category); screws (product_family) | Safety rule: Restrict fixing recommendations near hidden electrical wiring; require non-conductive inspection / stud finding |
| **#56** | Do you sell galvanised nails for outdoor framing? | Fixings & Fasteners | nails (product_family); clouts -> Loose Nails | Fully covered by existing taxonomy |
| **#57** | What's the difference between coach screws and bolts? | Fixings & Fasteners | screws (product_family); bolts -> Bolts & Nut | Fully covered by existing taxonomy |
| **#58** | What drill should I use for masonry walls? | Tools | masonry (product_category) | Masonry fastener installation: drill bit diameter must exactly match anchor sleeve diameter; blow dust out before inserting |
| **#59** | What trimmer should I use for hedges? | Tools | None directly matched | Fully covered by existing taxonomy |
| **#60** | Do you sell cordless screw driving systems? | Tools | None directly matched | Fully covered by existing taxonomy |
| **#61** | What saw do I need to cut treated timber? | Tools | None directly matched | Fully covered by existing taxonomy |
| **#62** | Do you have a Paslode Trim Master in stock? | Tools | None directly matched | Paslode collated nail compatibility: D-head vs round head, fuel cell vs gasless, 30-34 degree collation |
| **#63** | What's the best tool for driving batten and cradle deck systems? | Tools | None directly matched | Fully covered by existing taxonomy |
| **#64** | I need a reciprocating saw blade for demolition work | Tools | sawzall -> Reciprocating Saws | Fully covered by existing taxonomy |
| **#65** | What drill bit should I use for tiles? | Tools | None directly matched | Fully covered by existing taxonomy |
| **#66** | Do you have hand tools for plumbing repairs? | Tools | tools (department); hand tools (product_category) | Fully covered by existing taxonomy |
| **#67** | What power tool is best for cutting plywood sheets? | Tools | plywood (product_category); ply -> Timber & Plywood > Plywood | Fully covered by existing taxonomy |
| **#68** | Looking for a multitap - do you have one chilled and brushed? | Tools | loo -> Toilets; taps -> Tapware & Showering | Fully covered by existing taxonomy |
| **#69** | What tool should I use to drive screws into GIB board? | Tools | screws (product_family); gib -> Building Products > Plasterboard | Plasterboard -> 25mm/32mm drywall screws, joint compound, paper tape |
| **#70** | Do you sell PVC piping and fittings? | Plumbing & Bathroom | None directly matched | Fully covered by existing taxonomy |
| **#71** | What plumbing tools do I need for a basic bathroom repair? | Plumbing & Bathroom | tools (department); plumbing tools (product_category) | Fully covered by existing taxonomy |
| **#72** | Looking for bathroom accessories and fixtures | Plumbing & Bathroom | bathroom accessories (product_category); accessories (product_category); loo -> Toilets | Fully covered by existing taxonomy |
| **#73** | Do you have piping systems for a kitchen renovation? | Plumbing & Bathroom | project:kitchen_update (Kitchen update) | Fully covered by existing taxonomy |
| **#74** | What fittings do I need to join two pipes of different sizes? | Plumbing & Bathroom | None directly matched | Fully covered by existing taxonomy |
| **#75** | Do you sell kitchen benchtops? | Plumbing & Bathroom | kitchen benchtops (product_category); benchtops -> Kitchen Benchtops | Fully covered by existing taxonomy |
| **#76** | I need a tap for my kitchen sink | Plumbing & Bathroom | taps -> Tapware & Showering | Fully covered by existing taxonomy |
| **#77** | What plumbing supplies do you stock for outdoor taps? | Plumbing & Bathroom | taps -> Tapware & Showering | Fully covered by existing taxonomy |
| **#78** | Do you have pavers for a garden pathway? | Landscaping & Outdoor | pavers -> Paving | Paving installation recipe: GAP20 basecourse, sand bedding layer, paving stones, jointing sand; Paver thickness guide: 40-50mm for pedestrian footpaths vs 60-80mm interlocking for vehicular driveways |
| **#79** | I need a clothesline for my backyard | Landscaping & Outdoor | None directly matched | Fully covered by existing taxonomy |
| **#80** | What products do you have for lawn and plant care? | Landscaping & Outdoor | None directly matched | Fully covered by existing taxonomy |
| **#81** | Do you sell translucent roofing for a carport? | Landscaping & Outdoor | translucent roofing (product_category); roofing (product_category) | Fully covered by existing taxonomy |
| **#82** | Looking for gardening tools - spades, rakes, etc. | Landscaping & Outdoor | tools (department); loo -> Toilets | Fully covered by existing taxonomy |
| **#83** | What do I need for a retaining wall in a sloped garden? | Landscaping & Outdoor | None directly matched | Timber retaining wall recipe: H4 posts, H4 tongue-and-groove or rough sawn rails, scoria backfill, perforated drainage coil, filter sock; Retaining timber -> 12mm galvanised coach screws, perforated drain coil, geotextile fabric; Building consent threshold note: Retaining walls over 1.5m or supporting surcharge load require building consent and engineering |
| **#84** | Do you have plant and pest control products? | Landscaping & Outdoor | None directly matched | Fully covered by existing taxonomy |
| **#85** | What's the best paving option for a driveway? | Landscaping & Outdoor | paving (product_category) | Paving installation recipe: GAP20 basecourse, sand bedding layer, paving stones, jointing sand; Paver thickness guide: 40-50mm for pedestrian footpaths vs 60-80mm interlocking for vehicular driveways |
| **#86** | I want to build a cabinet | Vague DIY Project Prompts | None directly matched | Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners; Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue |
| **#87** | I want to build a pink colour cabinet from scratch | Vague DIY Project Prompts | None directly matched | Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners; Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue |
| **#88** | Help me build a deck in my backyard | Vague DIY Project Prompts | project:deck_build (Deck build); deck_project_extras: project:deck_build -> Wood Screws, Woodcare, Outdoor Cleaners | Fully covered by existing taxonomy |
| **#89** | I'm renovating my bathroom, where do I start? | Vague DIY Project Prompts | project:bathroom_renovation (Bathroom renovation); bathroom_project_extras: project:bathroom_renovation -> Heated Towel Rails, Mirrors, Wet Wall Linings | Fully covered by existing taxonomy |
| **#90** | I want to put up a new fence around my property | Vague DIY Project Prompts | project:fence_build (Fence build); fence_project_extras: project:fence_build -> Fencing & Netting (Non Timber) > Metal Gates | Fence rails -> H4 fence posts, galvanised framing nails, Rapid Set concrete |
| **#91** | What do I need to build a garden shed? | Vague DIY Project Prompts | None directly matched | Fully covered by existing taxonomy |
| **#92** | I'm doing a kitchen makeover, what should I look at? | Vague DIY Project Prompts | project:kitchen_update (Kitchen update); loo -> Toilets | Fully covered by existing taxonomy |
| **#93** | I want to insulate my house before winter | Vague DIY Project Prompts | project:insulate_home (Insulating a home); insulation_protection: project:insulate_home -> Respiratory Protection, Hand Protection, Eye Protection | Fully covered by existing taxonomy |
| **#94** | Help me plan a small landscaping project | Vague DIY Project Prompts | None directly matched | Fully covered by existing taxonomy |
| **#95** | I want to build a pergola over my patio | Vague DIY Project Prompts | None directly matched | Fully covered by existing taxonomy |
| **#96** | Find me a jib | Synonym & Guardrail Edge Cases | None directly matched | Glossary entry: "jib" -> GIB® plasterboard |
| **#97** | What's a dwang and where do I find one? | Synonym & Guardrail Edge Cases | framing_timber -> Timber & Plywood > Structural Grade Timber Kiln Dried | Fully covered by existing taxonomy |
| **#98** | I need a nogging piece of timber, what's that called here? | Synonym & Guardrail Edge Cases | framing_timber -> Timber & Plywood > Structural Grade Timber Kiln Dried | Fully covered by existing taxonomy |
| **#99** | What nails are safe to use near power outlets? | Synonym & Guardrail Edge Cases | nails (product_family) | Safety rule: Restrict fixing recommendations near hidden electrical wiring; require non-conductive inspection / stud finding |
| **#100** | asdkfj cabinet timber 4x2 | Synonym & Guardrail Edge Cases | framing_timber -> Timber & Plywood > Structural Grade Timber Kiln Dried | Graceful fallback for garbled queries: identify recognizable sub-tokens (cabinet, timber, 4x2) while acknowledging unclear text; Cabinet build recipe: 16mm/18mm MDF or melamine, iron-on edging tape, pocket hole screws, concealed hinges, drawer runners; Cabinet panels -> cabinet hinge screws, edge banding, PVA wood glue |
