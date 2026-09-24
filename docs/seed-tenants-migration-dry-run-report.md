# JourneyAX Seed Tenants — Migration Inventory & Dry-Run Evaluation Report

**Generated At**: `2026-09-24T12:14:16.018Z`  
**Branch / Commit**: `JourneyAX-dev-v4` (`7433eab`)  
**Evaluation Mode**: Dry-Run Schema Compilation & Canonical Conformance Check  

> **GOVERNANCE NOTICE**: Dry-run evaluation validates candidate Business Pack release schema compilation and semantic integrity. It does **not** grant cutover approval. Production routing strictly requires an approved, signed `DurableCutoverRecord` in `tenant_cutovers`.

---

## 1. Executive Summary

All **6 seed tenants** (caroma, placemakers, abercrombie, momentec, garts, dragonshield) were evaluated against the canonical `BusinessPackReleaseSchema` and semantic integrity rules.

| Status | Tenants Count | Percentage |
| :--- | :--- | :--- |
| **Schema Dry-Run Passed** | 6 / 6 | 100% |
| **Requires Remediation** | 0 / 6 | 0% |

## 2. Tenant Migration Inventory & Telemetry

| Tenant ID | Brand Name | Industry | Mode | Residency | Products | Docs | Stages | Tools |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `caroma` | Caroma Australia | Commercial & Residential Bathrooms | `quote` | `au` | 0 | 3770 | 3 | 4 |
| `placemakers` | PlaceMakers New Zealand | Building Materials & Trade Supplies | `quote` | `au` | 42435 | 113391 | 3 | 3 |
| `abercrombie` | Abercrombie & Fitch | Premium Lifestyle Apparel & Fashion | `cart` | `us` | 4429 | 4461 | 3 | 4 |
| `momentec` | Momentec Brands (Augusta Sportswear) | Athletic Uniforms & Custom Decorated Teamwear | `quote` | `us` | 0 | 0 | 3 | 4 |
| `garts` | Garts Sports & Outdoor Gear | Outdoor Equipment & Athletic Footwear | `cart` | `us` | 0 | 0 | 3 | 4 |
| `dragonshield` | Dragon Shield | Trading Card Game Accessories & Protection | `cart` | `eu` | 491 | 506 | 3 | 4 |

## 3. Dry-Run Schema Conformance & Checksums

| Tenant ID | Schema Conformance | Semantic Validity | Checksum (SHA-256) | Dry-Run Status |
| :--- | :---: | :---: | :--- | :---: |
| `caroma` | ✅ PASS | ✅ PASS | `1d3742622fd396de...` | 🟢 PASSED (DRY RUN) |
| `placemakers` | ✅ PASS | ✅ PASS | `77276015d3c7db35...` | 🟢 PASSED (DRY RUN) |
| `abercrombie` | ✅ PASS | ✅ PASS | `777fc8efa985fe6c...` | 🟢 PASSED (DRY RUN) |
| `momentec` | ✅ PASS | ✅ PASS | `4e11f4d50519bdf1...` | 🟢 PASSED (DRY RUN) |
| `garts` | ✅ PASS | ✅ PASS | `67372fd876981e08...` | 🟢 PASSED (DRY RUN) |
| `dragonshield` | ✅ PASS | ✅ PASS | `915285bfafc78377...` | 🟢 PASSED (DRY RUN) |

## 4. Architectural Findings by Vertical

### Caroma Australia (`caroma`)
- **Industry Vertical**: Commercial & Residential Bathrooms
- **Commerce Surface Mode**: `quote`
- **Evidenced Data Residency**: `au`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 3 extracted context keys.
- **Validation Issues**: None (Clean compilation)

### PlaceMakers New Zealand (`placemakers`)
- **Industry Vertical**: Building Materials & Trade Supplies
- **Commerce Surface Mode**: `quote`
- **Evidenced Data Residency**: `au`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 2 extracted context keys.
- **Validation Issues**: None (Clean compilation)

### Abercrombie & Fitch (`abercrombie`)
- **Industry Vertical**: Premium Lifestyle Apparel & Fashion
- **Commerce Surface Mode**: `cart`
- **Evidenced Data Residency**: `us`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 3 extracted context keys.
- **Validation Issues**: None (Clean compilation)

### Momentec Brands (Augusta Sportswear) (`momentec`)
- **Industry Vertical**: Athletic Uniforms & Custom Decorated Teamwear
- **Commerce Surface Mode**: `quote`
- **Evidenced Data Residency**: `us`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 3 extracted context keys.
- **Validation Issues**: None (Clean compilation)

### Garts Sports & Outdoor Gear (`garts`)
- **Industry Vertical**: Outdoor Equipment & Athletic Footwear
- **Commerce Surface Mode**: `cart`
- **Evidenced Data Residency**: `us`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 2 extracted context keys.
- **Validation Issues**: None (Clean compilation)

### Dragon Shield (`dragonshield`)
- **Industry Vertical**: Trading Card Game Accessories & Protection
- **Commerce Surface Mode**: `cart`
- **Evidenced Data Residency**: `eu`
- **Stages & Transitions**: 3 stages with explicit exit conditions.
- **Context Scoping Dimensions**: 3 extracted context keys.
- **Validation Issues**: None (Clean compilation)

---

**Report Verified and Signed by JourneyAX Platform Engineering.**
