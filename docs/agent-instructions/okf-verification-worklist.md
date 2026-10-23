# OKF Verification Worklist

This worklist tracks technical specifications, product dimensions, installation rules, and calculator constants removed from agent instructions or pending authoritative verification from manufacturer documentation or industry standards.

In accordance with strict grounding and zero-hallucination principles, agent prompt instructions govern only agent behavior and compliance boundaries. All concrete product facts, engineering dimensions, and installation parameters must be stored in the Operational Knowledge Framework (OKF) or the product catalogue, supported by a verifiable `verificationRef`.

---

## 1. Wallboard Fasteners & Installation Parameters (V5)

| Specification Item | Context / Removed Value | Source Document Needed | Required Verification Reference | Status |
|---|---|---|---|---|
| Wallboard screw dimensions (timber) | 6g x 25mm, 6g x 32mm coarse thread | Winstone Wallboards GIB Site Guide | `okf:gib-site-guide-2022#fasteners-timber` | Pending OKF ingestion |
| Wallboard screw dimensions (steel) | Self-tapper / fine thread | Winstone Wallboards GIB Site Guide | `okf:gib-site-guide-2022#fasteners-steel` | Pending OKF ingestion |
| Screw spacing and centres | 300mm centres to wall/ceiling framing | Winstone Wallboards GIB Site Guide | `okf:gib-site-guide-2022#fixing-centres` | Pending OKF ingestion |
| Screw seating depth | Seated flush or slightly below surface without breaking paper | Winstone Wallboards GIB Site Guide | `okf:gib-site-guide-2022#fixing-depth` | Pending OKF ingestion |

---

## 2. Quantity Estimation & Calculators (V8)

| Calculator / Formula | Unverified Constants / Assumptions | Verification Reference | Action / Status |
|---|---|---|---|
| Plasterboard sheet estimator | Sheet dimensions: 2.4m x 1.2m (2.88 m²)<br>Wastage allowance: 10% | `okf:placemakers-trade-calc#plasterboard-standard` | Moved to `docs/agent-instructions/calculators.placemakers.json`; requires verifier sign-off |
| Decking linear metre estimator | Board width: 90mm, 140mm<br>Gap spacing: 4mm–6mm<br>Wastage allowance: 10% | `okf:placemakers-trade-calc#decking-standard` | Moved to `docs/agent-instructions/calculators.placemakers.json`; requires verifier sign-off |

---

## 3. Structural & Compliance Escalation Boundaries

Agent prompt instructions must strictly refer customers to Licensed Building Practitioners (LBPs) or certified engineers for:
- Span calculations, load-bearing sizing, and lintel design under NZS 3604.
- Mains electrical wiring, switchboard upgrades, and circuits under AS/NZS 3000.
- Certified gas fitting or flued appliance installation under AS/NZS 5601.
- Internal wet-area waterproofing and tanking under NZBC Clause E3.
