# PlaceMakers Conversation Quality Evaluation Report: Agent Mode

> [!NOTE]
> **Agent Mode Evaluation**: Evaluates the autonomous AI-led loop with dynamic tool calling (parallel read-only tools, catalog search, OKF notes, present_card) and streaming sentence shaping with OKF Claim Guard.

- **Date**: 2026-10-23T05:53:50.130Z
- **Test Set**: PlaceMakers 100 Test Prompts (`placemakers-100.json`)
- **Mode**: Agent Mode (Real Model Gateway)
- **Total Prompts**: 100
- **Overall Pass Rate**: **91.0%** (91/100)

## Latency & Model Calls

| Metric | Value |
| --- | --- |
| p50 Time to First Text | 1827.0 ms |
| p95 Time to First Text | 3133.0 ms |
| p50 Total Turn Latency | 4529.0 ms |
| p95 Total Turn Latency | 7747.0 ms |
| Max Total Turn Latency | 11331.0 ms |
| Average Model Calls / Turn | 1.00 |
| Average Tool Calls / Turn | 1.15 |

## Slow Turns Audit (> 20s)

- **Zero turns exceeded 20s** (max turn latency: 11331.0 ms). All turns completed within the 20s SLA threshold.

## Pass Rate by Prompt Type

| Prompt Type | Total | Passed | Pass Rate | Evaluation Criteria |
| --- | --- | --- | --- | --- |
| **advice** | 20 | 19 | 95.0% | Grounded recommendation addressing row requirement |
| **education** | 4 | 4 | 100.0% | Explanatory answer without specific SKU enforcement |
| **garbled** | 1 | 1 | 100.0% | Graceful handling without crash or internal leakage |
| **product_lookup** | 53 | 48 | 90.6% | Expected SKU or matching product attributes (size, grade, brand, category) present |
| **project** | 13 | 11 | 84.6% | Scoping clarification or component recommendation |
| **safety** | 3 | 2 | 66.7% | Safety guidance/disclaimer, hazard awareness, no unsafe claims |
| **vocabulary** | 6 | 6 | 100.0% | Term resolution / Kiwi trade slang explanation |

## Pass Rate by Original Category

| Category | Total | Passed | Pass Rate |
| --- | --- | --- | --- |
| Building Materials | 12 | 11 | 91.7% |
| Fencing & Decking | 10 | 10 | 100.0% |
| Fixings & Fasteners | 10 | 7 | 70.0% |
| Landscaping & Outdoor | 8 | 8 | 100.0% |
| Paint & Finishes | 10 | 10 | 100.0% |
| Plumbing & Bathroom | 8 | 8 | 100.0% |
| Synonym & Guardrail Edge Cases | 5 | 5 | 100.0% |
| Timber & Dimensions | 15 | 12 | 80.0% |
| Tools | 12 | 12 | 100.0% |
| Vague DIY Project Prompts | 10 | 8 | 80.0% |

## Checks Summary

- **Answer Not Empty**: 100/100
- **No Internal IDs Leaked**: 100/100
- **Forbidden Claims Absent**: 100/100
- **Expected SKU / Product Attributes Present**: 95/100
- **Ground Truth Requirements Met**: 96/100

## Failure Sample (First 5)

- **#4** [Timber & Dimensions | product_lookup] "Looking for 150x50 treated pine for a deck frame": Shown products did not match all requested attributes
- **#9** [Timber & Dimensions | product_lookup] "What's your cheapest 6x2 treated timber?": Shown products did not match all requested attributes
- **#14** [Timber & Dimensions | product_lookup] "Do you have 100x100 treated posts for a pergola?": Shown products did not match all requested attributes
- **#30** [Building Materials | product_lookup] "Do you have Pink Batts in stock?": Shown products did not match all requested attributes
- **#48** [Fixings & Fasteners | product_lookup] "What screw should I use for wallboard?": No matching products shown and attributes not mentioned
