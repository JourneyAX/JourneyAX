# PlaceMakers Conversation Quality Evaluation Report: Agent Mode

> [!NOTE]
> **Agent Mode Evaluation**: Evaluates the autonomous AI-led loop with dynamic tool calling (parallel read-only tools, catalog search, OKF notes, present_card) and streaming sentence shaping with OKF Claim Guard.

- **Date**: 2026-10-22T21:42:14.314Z
- **Test Set**: PlaceMakers 100 Test Prompts (`placemakers-100.json`)
- **Mode**: Agent Mode (Real Model Gateway)
- **Total Prompts**: 100
- **Overall Pass Rate**: **57.0%** (57/100)

## Latency & Model Calls

| Metric | Value |
| --- | --- |
| p50 Time to First Text | 1531.0 ms |
| p95 Time to First Text | 2949.0 ms |
| p50 Total Turn Latency | 2047.0 ms |
| p95 Total Turn Latency | 5254.0 ms |
| Max Total Turn Latency | 9437.0 ms |
| Average Model Calls / Turn | 1.00 |
| Average Tool Calls / Turn | 0.70 |

## Slow Turns Audit (> 20s)

- **Zero turns exceeded 20s** (max turn latency: 9437.0 ms). All turns completed within the 20s SLA threshold.

## Pass Rate by Prompt Type

| Prompt Type | Total | Passed | Pass Rate | Evaluation Criteria |
| --- | --- | --- | --- | --- |
| **advice** | 20 | 20 | 100.0% | Grounded recommendation, no unverified claims |
| **education** | 4 | 4 | 100.0% | Explanatory answer without specific SKU enforcement |
| **garbled** | 1 | 1 | 100.0% | Graceful handling without crash or internal leakage |
| **product_lookup** | 52 | 9 | 17.3% | Expected SKU/category in response |
| **project** | 13 | 13 | 100.0% | Project planning / clarification response |
| **safety** | 4 | 4 | 100.0% | Safety guidance/disclaimer, no unsafe claims |
| **vocabulary** | 6 | 6 | 100.0% | Term resolution without failure |

## Pass Rate by Original Category

| Category | Total | Passed | Pass Rate |
| --- | --- | --- | --- |
| Building Materials | 12 | 6 | 50.0% |
| Fencing & Decking | 10 | 6 | 60.0% |
| Fixings & Fasteners | 10 | 5 | 50.0% |
| Landscaping & Outdoor | 8 | 3 | 37.5% |
| Paint & Finishes | 10 | 6 | 60.0% |
| Plumbing & Bathroom | 8 | 2 | 25.0% |
| Synonym & Guardrail Edge Cases | 5 | 5 | 100.0% |
| Timber & Dimensions | 15 | 5 | 33.3% |
| Tools | 12 | 9 | 75.0% |
| Vague DIY Project Prompts | 10 | 10 | 100.0% |

## Checks Summary

- **Answer Not Empty**: 100/100
- **No Internal IDs Leaked**: 100/100
- **Forbidden Claims Absent**: 100/100
- **Expected SKU Present (where applicable)**: 57/100

## Failure Sample (First 5)

- **#1** [Timber & Dimensions | product_lookup] "Do you have 100x50 H3.2 treated timber in stock?": Expected SKU not found (expected: 1002835, 1003586, 1003591)
- **#2** [Timber & Dimensions | product_lookup] "I need 4x2 timber for framing, what do you have?": Expected SKU not found (expected: 1002835, 1010788, 1003586)
- **#4** [Timber & Dimensions | product_lookup] "Looking for 150x50 treated pine for a deck frame": Expected SKU not found (expected: 1002836, 1003596, 1003601)
- **#5** [Timber & Dimensions | product_lookup] "Do you sell untreated structural timber?": Expected SKU not found (expected: 2420248, 2420911, 1202498)
- **#7** [Timber & Dimensions | product_lookup] "9x15 timber for a fence rail - do you stock that?": Expected SKU not found (expected: 1074723, 2330974, 2339323)
