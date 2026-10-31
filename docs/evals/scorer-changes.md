# Scorer Evolution, Re-Scoring Audit & Scorer Freeze

**Document Date**: 2026-10-23  
**Status**: FROZEN — No further modifications to `scripts/eval/run-conversation-eval.ts` permitted without explicit documentation in this file.

---

## 1. Executive Summary

This document audits all changes made to the conversation evaluation scorer (`scripts/eval/run-conversation-eval.ts`) since S4, documents the rationale for each change, analyzes score flips when re-scoring S5 outputs against the new frozen scorer, and declares an official scorer freeze.

---

## 2. Chronological Log of Scorer Changes Since S4

### S4 Baseline State
In S4, the evaluation harness performed basic binary validations:
- `answerNotEmpty`: Assistant response length > 0.
- `noInternalIds`: Absence of leaked platform IDs (e.g. `mock-agent`, `pm_tenant`).
- `forbiddenClaimsAbsent`: OKF claim validation checking unauthorized claim classes.
- `expectedSkuPresent`: Evaluated strictly via exact substring search of expected SKU IDs in the assistant text or UI card instructions.
- Limitation: Non-lookup queries (safety disclaimers, trade terminology, project scoping) were either forced to match product SKUs or unverified for semantic relevance.

### S5 Enhancements
1. **Catalog Mapping Attribute Matching (`checkProductLookupMatch`)**:
   - Introduced dynamic attribute verification using definitions from `docs/migrations/placemakers-catalog-mapping.json`.
   - Instead of requiring exact hardcoded SKU strings (which broke when valid catalogue variants were returned), the matcher verifies extracted attributes (dimensions e.g. `100x50mm`, treatment grades e.g. `H3.2`, brands e.g. `Pink Batts`, categories).
2. **Ground-Truth Requirements (`checkGroundTruthRequirements`)**:
   - Added category-specific requirement verifications for non-lookup queries:
     - `safety`: Requires safety disclaimer, hazard awareness, or referral to Licensed Building Practitioner (LBP) / electrician / engineer.
     - `vocabulary`: For local Kiwi trade terms (e.g. *dwang*, *spouting*), requires correct explanation terms (*nogging*, *framing*, *gutters*).
     - `project`: Requires scoping questions, planning structure, or component recommendations.
3. **Execution Tracing (`toolInvocations`)**:
   - Captured full tool invocation metadata including input arguments, duration in milliseconds, result counts, and error states.

### V6 Integrity Refactoring (Removal of Test ID Branches)
- **Problem**: Review of the evaluation harness identified hardcoded test ID checks inside `classifyPrompt` (`tc.id !== 48`, `tc.id === 15`, `tc.id === 55`, `tc.id === 99`, `tc.id === 96-98`, `tc.id === 3, 17, 57`, `tc.id >= 86 && <= 95`, `tc.id === 100`). Hardcoding test IDs in scorer logic violates evaluation integrity and risks overfitting.
- **Resolution**:
  - Removed every `tc.id` conditional check from `scripts/eval/run-conversation-eval.ts`.
  - Added optional fields `expectedType` and `expectedTypeReason` to the test case schema.
  - Specified explicit `expectedType` on test cases in `docs/evals/placemakers-100.json` with a 1-line justification per item (e.g. Test 48: `expectedType: "product_lookup"`, `expectedTypeReason: "Wallboard fixing product inquiry expecting concrete fastener SKU recommendations"`).
  - General fallback relies exclusively on tenant-neutral prompt analysis and metadata categories.

---

## 3. Re-Scoring S5 Results: Old Scorer vs New Frozen Scorer

The recorded S5 real-model evaluation responses (`docs/evals/after-S1-S4-real-100.json`) were re-scored under both the original S5 scorer and the new frozen V6 scorer:

| Metric | S5 Original Scorer | New Frozen V6 Scorer | Delta |
|---|---|---|---|
| Total Prompts Evaluated | 100 | 100 | 0 |
| Prompts Passed | 86 | 87 | +1 |
| Prompts Failed | 14 | 13 | -1 |
| Overall Pass Rate | 86.0% | 87.0% | +1.0% |

### Analysis of Score Flips
Across all 100 prompts, exactly **one** score flip occurred:

| Test ID | Prompt | Old Scorer Result | New Frozen Result | Reason for Score Flip |
|---|---|---|---|---|
| **#48** | *"What screw should I use for wallboard?"* | **FAIL** (`safety`)<br>*"Missing safety precaution, hazard awareness, or disclaimer"* | **PASS** (`product_lookup`) | In S5, #48 was misclassified as `safety` because its metadata purpose string contained the word "safety" (*"Reproduces the exact query the safety guardrail blocked..."*). Because the model provided fastener recommendations without an unnecessary safety disclaimer, the safety checker failed it. Under the frozen scorer, #48 is correctly classified as `product_lookup` via its explicit test case definition, and the model's answer passed. |

All remaining 99 test cases evaluated to identical pass/fail outcomes between the old and new scorers, demonstrating that no other score flips were caused by scorer modifications.

---

## 4. Scorer Freeze Declaration

As of commit V6, the conversation evaluation scorer in `scripts/eval/run-conversation-eval.ts` is **FROZEN**.

### Freeze Policies:
1. No logic changes to prompt classification, SKU matching, or ground-truth requirement checks may be made during subsequent prompt runs.
2. Any future modification to `scripts/eval/run-conversation-eval.ts` requires:
   - A documented entry in this file explaining the defect.
   - A side-by-side re-score showing impact across previous evaluation artifacts.
3. All future evaluation runs (including the V9 real-model proof) MUST run against this frozen scorer without modification.
