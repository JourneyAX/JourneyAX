# PlaceMakers Conversation Quality Evaluation Report: Agent Mode

> [!NOTE]
> **Agent Mode Evaluation**: Evaluates the autonomous AI-led loop with dynamic tool calling (parallel read-only tools, catalog search, OKF notes, present_card) and streaming sentence shaping with OKF Claim Guard.

- **Date**: 2026-10-20T16:49:50.020Z
- **Test Set**: PlaceMakers 100 Test Prompts ()
- **Mode**: Agent Mode (Real Model Gateway)
- **Total Prompts**: 100
- **Overall Pass Rate**: **51.0%** (51/100)

## Latency & Model Calls

| Metric | Value |
| --- | --- |
| p50 Time to First Text | 2079.0 ms |
| p95 Time to First Text | 734407.0 ms |
| p50 Total Turn Latency | 4790.0 ms |
| p95 Total Turn Latency | 734407.0 ms |
| Average Tool Calls / Turn | 1.09 |

## Pass Rate by Prompt Type

| Prompt Type | Total | Passed | Pass Rate | Evaluation Criteria |
| --- | --- | --- | --- | --- |
| **advice** | 20 | 20 | 100.0% | |
| **education** | 4 | 4 | 100.0% | |
| **garbled** | 1 | 1 | 100.0% | |
| **product_lookup** | 52 | 4 | 7.7% | |
| **project** | 13 | 13 | 100.0% | |
| **safety** | 4 | 3 | 75.0% | |
| **vocabulary** | 6 | 6 | 100.0% | |

## Pass Rate by Original Category

| Category | Total | Passed | Pass Rate |
| --- | --- | --- | --- |
| Building Materials | 12 | 7 | 58.3% |
| Fencing & Decking | 10 | 4 | 40.0% |
| Fixings & Fasteners | 10 | 4 | 40.0% |
| Landscaping & Outdoor | 8 | 2 | 25.0% |
| Paint & Finishes | 10 | 5 | 50.0% |
| Plumbing & Bathroom | 8 | 2 | 25.0% |
| Synonym & Guardrail Edge Cases | 5 | 5 | 100.0% |
| Timber & Dimensions | 15 | 4 | 26.7% |
| Tools | 12 | 8 | 66.7% |
| Vague DIY Project Prompts | 10 | 10 | 100.0% |

## Checks Summary

- **Answer Not Empty**: 100/100
- **No Internal IDs Leaked**: 100/100
- **Forbidden Claims Absent**: 97/100
- **Expected SKU Present (where applicable)**: 52/100
