# JourneyAX Tenant Connector Migration Inventory & Truthful Audit

**Audit Timestamp**: `2026-09-24T23:10:03.865Z`
**Branch**: `JourneyAX-dev-v4`
**Audit Mode**: Read-Only Architecture Enforcement & Evidence-Backed Verification

> **MIGRATION STATUS NOTICE**: This inventory reflects actual computed evaluations. Discovered repository migration sources are explicitly distinguished from synthetic test fixtures. No hardcoded compliance claims or artificial pass flags are permitted. Direct provider URLs in runtime paths are prohibited; legacy direct adapters remain frozen as migration sources until canary cutover approvals are signed.

---

## 1. Executive Summary

| Metric | Computed Value | Assessment |
| :--- | :--- | :--- |
| **Discovered Migration Sources** | 4 | Filesystem packs (2) + Seed configs (2) |
| **Synthetic Test Fixtures** | 5 | Evaluated for connector topology testing only |
| **Immutable Release Ready** | 9 / 9 | Computed via real schema and reference validation |
| **Activepieces Connector Boundary Compliant** | 7 / 9 | Scanned for direct provider URLs and raw secrets |
| **Grounded Retrieval Isolation** | 9 / 9 | Evaluated via CatalogSearchHandler execution |

## 2. Tenant Inventory & Discovered Source Matrix

| Tenant ID | Brand Name | Source Category | Industry | Commerce Mode | Activepieces Flows | Status |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: |
| `royalcyber` | Royal Cyber Inc. | `filesystem_pack` | IT Consulting & Digital Transformation | `quote` | 2 flows | `CANDIDATE_PACK_VALIDATED` |
| `workweargroup` | Workwear Group | `filesystem_pack` | Industrial Workwear, Uniforms & Safety Apparel | `quote` | 1 flows | `CANDIDATE_PACK_VALIDATED` |
| `caroma` | Caroma Australia | `seed_config` | Commercial & Residential Bathrooms | `quote` | 2 flows | `CANDIDATE_PACK_VALIDATED` |
| `caroma-nz` | Caroma New Zealand | `seed_config` | Bathrooms & Plumbing | `quote` | 2 flows | `CANDIDATE_PACK_VALIDATED` |
| `placemakers` | PlaceMakers New Zealand | `synthetic_fixture` | Building Materials & Trade Supplies | `quote` | 1 flows | `FIXTURE_EVALUATION_ONLY` |
| `abercrombie` | Abercrombie & Fitch | `synthetic_fixture` | Retail Apparel & Fashion | `cart` | 1 flows | `FIXTURE_EVALUATION_ONLY` |
| `momentec` | Momentec Brands | `synthetic_fixture` | Custom Sports & Athletic Apparel | `cart` | 1 flows | `FIXTURE_EVALUATION_ONLY` |
| `garts` | Gart Sports & Outdoor | `synthetic_fixture` | Sporting Goods & Outdoor Recreation | `quote` | 1 flows | `FIXTURE_EVALUATION_ONLY` |
| `dragonshield` | Dragon Shield (Arcane Tinmen) | `synthetic_fixture` | Gaming Accessories & Card Sleeves | `cart` | 1 flows | `FIXTURE_EVALUATION_ONLY` |

## 3. Computed Conformance & Evidence Audit

| Tenant ID | Schema | Semantics | Ref Integrity | Isolated? | Raw Secrets | Direct URLs | Checksum |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `royalcyber` | PASS | PASS | PASS | YES | 0 | 0 | `3377aa6848a96e9c...` |
| `workweargroup` | PASS | PASS | PASS | YES | 0 | 0 | `fb5133ff8f2e7f93...` |
| `caroma` | PASS | PASS | PASS | YES | 0 | 0 | `89a323adb0be5ee2...` |
| `caroma-nz` | PASS | PASS | PASS | YES | 0 | 0 | `9a3d58cd07df2012...` |
| `placemakers` | PASS | PASS | PASS | YES | 0 | 0 | `f2a42c49ec3142a2...` |
| `abercrombie` | PASS | PASS | PASS | YES | 0 | 0 | `e0da474cedea0139...` |
| `momentec` | PASS | PASS | PASS | YES | 0 | 0 | `9e80cc59995da127...` |
| `garts` | PASS | PASS | PASS | YES | 0 | 0 | `02af650e61f40fb2...` |
| `dragonshield` | PASS | PASS | PASS | YES | 0 | 0 | `814cc2121f411203...` |

## 4. Migration Operational State, Cutover Records & Blockers

| Tenant ID | Cutover Record (`tenant_cutovers`) | Rollback Baseline | Blockers Count | Specific Blockers |
| :--- | :---: | :---: | :---: | :--- |
| `royalcyber` | `NO_RECORD_FOUND` | `BASELINE_CONFIRMED` | 2 | Connector boundary compliance violated; Cutover approval record missing in tenant_cutovers |
| `workweargroup` | `NO_RECORD_FOUND` | `BASELINE_CONFIRMED` | 2 | Connector boundary compliance violated; Cutover approval record missing in tenant_cutovers |
| `caroma` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 2 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers |
| `caroma-nz` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 2 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers |
| `placemakers` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 3 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers; Synthetic test fixture: not a discovered customer project |
| `abercrombie` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 3 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers; Synthetic test fixture: not a discovered customer project |
| `momentec` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 3 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers; Synthetic test fixture: not a discovered customer project |
| `garts` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 3 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers; Synthetic test fixture: not a discovered customer project |
| `dragonshield` | `NO_RECORD_FOUND` | `NO_ROLLBACK_BASELINE` | 3 | Cutover approval record missing in tenant_cutovers; Rollback baseline snapshot missing in business_pack_pointers; Synthetic test fixture: not a discovered customer project |

## 5. Architecture Signoff Status

**STATUS**: PENDING ARCHITECTURE GOVERNANCE & SECURITY APPROVAL

*Notice: In compliance with Workstream D truthful reporting requirements, no approval or signature is certified because cutover records in `tenant_cutovers` remain pending.*
