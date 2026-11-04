# Phase 2 complete repeat — prompt v3

Six live attempts on November 4, 2026 used the production comparator with `condition-comparison-text-v3`, `gemini-3.5-flash-lite`, `v1beta generateContent`, temperature 0 and constrained JSON. The model received authored synthetic illustrations, never private homes or identity documents. Expectations were written before inference. The original v2 artifacts, including their lighting false positive, remain separately preserved in `output/condition-phase-two`.

This review compares returned text against the user's expected case behavior and the fixture generation source. It is an agent-assisted qualitative feasibility check; independent human presentation review remains appropriate. Five valid results and one failed attempt cannot support statistical accuracy or real-home generalization claims.

| Case | Result | False positives / misses | Appropriate restraint and clarity | Latency |
| --- | --- | --- | --- | --- |
| 1 Identical | Empty findings, `compared` | None observed | Clear no-change summary | 19,474 ms |
| 2 Lighting | Empty findings; tint/exposure noted in limitation | The v2 tint-only finding did not recur in this run | Appropriate; no surface-damage inference | 18,931 ms |
| 3 Moved furniture | **Network/timeout; no valid model result** | Cannot assess recognition or false positives | No model conclusion. This case also timed out during v2. | 45,042 ms |
| 4 Wall mark | One finding describes new back-wall zigzag mark | Correct authored change, no extra defect observed | Neutral and specific; cause/liability not inferred | 22,006 ms |
| 5 Obstruction | `limited`, no findings, occlusion limitation | No fabricated hidden changes | Appropriate abstention, understandable explanation | 13,367 ms |
| 6 Multiple | Two findings cover both wall marks together and the floor patch separately | All three authored changes recognized, but wall marks grouped | Useful evidence; grouping falls short of one observation per physical feature | 24,815 ms |

Five completed responses reported 13,104 total tokens: 12,445 prompt and 659 candidate tokens. Successful latency range was 13.367–24.815 seconds; median 19.474 seconds. No usage was returned for the timed-out attempt; no billing conclusion can be drawn from missing usage.

No bounding boxes were requested or rendered. The reliable interface is textual suggestions beside preserved original photographs, followed by human review. Cases 7 and 8 are separate workflow evidence: no-baseline manual documentation and injected provider unavailability with bounded retries. They are not extra live model samples.

Truthful claim: **Nibash can produce structured visible-change suggestions for review on these authored examples, and safely allows manual inspection when comparison is unavailable.** Do not claim robust furniture handling based on this run, perfect lighting robustness, all-damage detection, calibrated confidence, trustworthy region localization or independently verified image authenticity.
