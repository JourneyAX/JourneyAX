# JourneyAX — Canonical Pack Dry-Run Evaluation Report

**Generated At**: `2026-09-28T12:09:35.813Z`

**Branch / Commit**: `JourneyAX-dev-v4` / `27362a127e6df3e81516665707cdd9aa69e679fe`

**Portfolio Manifest Version**: `1.0.0`

**Evaluation Mode**: Offline Filesystem Dry-Run — schema compilation and canonical conformance.

**Active Portfolio**: placemakers, workweargroup, abercrombie, caroma

**Parked (excluded)**: royalcyber, caroma-nz, momentec, garts, dragonshield

> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack schema compilation and semantic integrity. It does **not** grant cutover approval. Production routing strictly requires an approved, signed `DurableCutoverRecord` in `tenant_cutovers`. Any discovered tenant absent from the portfolio manifest is classified as `UNREGISTERED` and `BLOCKED`.

---

## 1. Executive Summary

| Category | Configured | Discovered on Disk | Status / Count |
| :--- | :---: | :---: | :--- |
| Active portfolio tenants | 4 | 4 | 4 passed, 0 pending authoring / blocked |
| Parked tenants (excluded from readiness) | 5 | 1 | 1 discovered, 4 pending authoring |
| Synthetic fixtures (excluded from readiness) | 5 | 0 | 5 configured |
| Unregistered tenants (governance violations) | — | 0 | 0 violations |

## 2. Active Portfolio Dry-Run Results

| Tenant ID | Version | Schema | Semantic | Checksum (SHA-256, first 16) | Status |
| :--- | :---: | :---: | :---: | :--- | :---: |
| `abercrombie` | `1.0.0` | ✅ PASS | ✅ PASS | `c1d621d36effcca1...` | 🟢 DRY_RUN_PASSED |
| `caroma` | `1.0.0` | ✅ PASS | ✅ PASS | `3beed455d6b687a9...` | 🟢 DRY_RUN_PASSED |
| `placemakers` | `1.0.0` | ✅ PASS | ✅ PASS | `3f66adbae9468d3d...` | 🟢 DRY_RUN_PASSED |
| `workweargroup` | `1.0.0` | ✅ PASS | ✅ PASS | `fb5133ff8f2e7f93...` | 🟢 DRY_RUN_PASSED |

## 3. Validation Issues

No validation issues found across all active-portfolio packs.

## 4. Parked Tenants (Excluded)

| Tenant ID | Source | Reason |
| :--- | :---: | :--- |
| `royalcyber` | `filesystem_pack` | Parked pending business prioritisation. Do not count as active blocker. |
| `caroma-nz` | `not_discovered` | Parked — will follow caroma (AU) once AU is migrated. |
| `momentec` | `not_discovered` | Parked pending stakeholder sign-off. |
| `garts` | `not_discovered` | Parked pending stakeholder sign-off. |
| `dragonshield` | `not_discovered` | Parked pending stakeholder sign-off. |

## 5. Synthetic Fixtures (Excluded from Readiness)

| Fixture ID | Source | Schema | Checksum | Note |
| :--- | :---: | :---: | :--- | :--- |
| `placemakers_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `abercrombie_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `caroma_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `momentec_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |
| `dragonshield_fixture` | `not_discovered` | ❌ FAIL | — | FIXTURE_EVALUATION_ONLY — not counted |

---

*This report was generated automatically from the canonical filesystem packs. It is a dry-run evaluation only — not a production cutover approval.*
