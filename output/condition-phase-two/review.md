# Phase 2 first live evaluation — prompt v2

On November 4, 2026, six live requests used `gemini-3.5-flash-lite`, `v1beta generateContent`, temperature 0, schema-constrained JSON and the production Phase 2 text-only comparator. Inputs were the six project-authored illustrations from Phase 1. `expectations.json` was persisted before the first inference, using the user's required case expectations and the fixture generation source. No private home photographs or identity documents were used.

This is an agent-assisted qualitative check against authored image content. It is not an independent human-labelled benchmark or an accuracy score. A presentation owner should review the original photographs and these results before making claims.

| Case | Actual output and qualitative check | False positives / misses | Abstention / clarity | Runtime |
| --- | --- | --- | --- | --- |
| Identical | `compared`, empty findings; no clear visible change | None observed | Concise, appropriate | 22,384 ms |
| Lighting | One `possible_visible_change` for grayer wall/ceiling tone, although summary attributes it to lighting | **False positive** for a tint-only difference. It does not explicitly label damage, but still creates an unnecessary condition finding. | Clear words; inadequate restraint | 5,516 ms |
| Moved furniture | No valid response: network/timeout | Recognition, false positives and misses cannot be assessed | Request failed at the configured timeout; no model conclusion | 45,036 ms |
| Wall mark | One `clear_visible_difference` describing the new dark zigzag wall mark | No extra defect observed; correct mark recognized | Specific location and neutral evidence; no cause/liability claim | 20,709 ms |
| Obstruction | `limited`, empty findings, explicit occlusion explanation for photo 2 | No fabricated hidden defects | Appropriate abstention; clear limitation | 35,864 ms |
| Multiple | Two findings: grouped wall lines and a separate floor patch | All three authored changes recognized, but the two wall marks were grouped rather than independently reviewable | Descriptions usable, wall location less specific than ideal | 33,275 ms |

Five valid responses report 13,011 total tokens combined (12,245 prompt + 766 candidate tokens). Successful latency ranged from 5.516 to 35.864 seconds; median 22.384 seconds. The timed-out request has no reported usage; this does not establish that it was unbilled. Raw provider output and metadata remain in `results.json`.

**Decision:** text comparison is useful as an inspection suggestion with human review, but this first run exposes a lighting false positive and a timeout. No robust lighting or complete damage-detection claim is supported. No numerical confidence or bounding boxes are used. Phase 1 localization failures remain preserved in `output/condition-vision`.

The prompt was subsequently tightened to v3 to explicitly forbid findings for lighting/tint alone. The initial v2 results remain untouched here. A new complete six-case evaluation is saved separately in `output/condition-phase-two-v3`; do not substitute its results for this failed first attempt.

Case 7 (no baseline) and Case 8 (model unavailable) are workflow checks, not six-pair model results. The database/API integration tests and isolated demo evidence must distinguish an injected unavailable provider from a genuine live outage. The moved-furniture timeout above is a genuine live failure, but is not a complete unavailable-provider workflow test.
