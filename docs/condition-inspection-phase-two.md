# Nibash Phase 2 implementation and evidence

Implemented and evaluated November 4, 2026; final verification resumed November 5, 2026, Bangladesh time. Implementation is local to the existing checkout. No deployment, production migration, production-secret change, or private-home inference was performed.

## Result and scope

The implemented journey is confirmed baseline → matched private move-out photos → durable comparison or manual fallback → landlord physical review → explicit condition acceptance plus independent tenant vacancy → completed inspection and controlled rental closure. A genuine Gemini comparison and both-role browser journey reached completion using authored synthetic evidence. AI never sets liability, calculates money, accepts the condition, confirms vacancy, or releases a listing.

The ordinary production image-processing gate remains off unless an operator explicitly enables it after reviewing safeguards. The local demo has an injected evaluator restricted to known synthetic fixture hashes. Its separate offline fixture mode is prominently labelled. The feature is ready for local demonstration; the production limitations below remain real.

## Phase 1 reused

- `condition_reports`, rooms, photos and append-only events; the confirmed root-tenancy version and hash remain unchanged.
- Canonical submission hashing, dual-party confirmation, normalized/oriented JPEG/PNG evidence and private `condition-evidence` storage.
- Existing JWT/revocation authentication, authorization before upload buffering, signed photo access, Notification Center and landlord contract navigation.
- Existing PostgreSQL durable-job lease/retry design, implemented in a separate home-evidence queue rather than the identity-document queue.
- Existing contract/root/renewal rules, physical-closure guard, listing release trigger and historical payment/receipt records.

Phase 1's actual six synthetic model results were inspected before choosing the implementation. Its stationary-table false positive and speculative crack wording were retained as evidence against automatic bounding-box display. See [the original report](condition-report-phase-one.md).

## Database and API changes

Additive migrations, tested locally:

| Migration | New structures |
| --- | --- |
| `022_move_out_inspections.sql` | `move_out_inspections`, `move_out_rooms`, `move_out_photos`, `move_out_events`; immutable identities/evidence, locked completed reports, append-only audit, private browser-role grants/RLS |
| `023_condition_analysis_jobs.sql` | Dedicated version/hash-bound jobs, unique input version, leases, retry scheduling, model/runtime/usage/raw-output metadata, private browser-role grants/RLS |

Inspection creation resolves the current accepted contract and its existing root baseline. A confirmed historical `current_condition` baseline stays labelled as such; it is not backdated into original move-in proof. Missing or unconfirmed baselines lead to manual documentation, with “No comparable baseline available” in the interface.

API base: `/api/contracts/:id/move-out-inspection`. Mutations validate expected evidence version and strict input shapes.

| Route | Purpose |
| --- | --- |
| GET /, POST / | Read or initiate authorized inspection |
| POST /rooms | Add a room |
| POST /photos | Private normalized upload with explicit room/baseline image match |
| POST /photos/:photoId/remove | Uploader-only retirement; original retained |
| GET /photos/:photoId/url | Authorized 120-second private download link |
| POST /submit | Freeze/hash the input snapshot; optionally grant external-processing permission/request analysis |
| POST /ai-consent | Grant/withdraw permission for exact version/hash |
| POST /analyze | Require both parties' current baseline and move-out permissions before enqueueing |
| POST /reviews | Landlord's separate per-finding decision and notes |
| POST /observations | Landlord's manual observation; optional `requires_review` opens further review |
| POST /resolve | Audited manual condition resolution; preserves original observations |
| POST /vacancy | Tenant's independent declaration of actual vacancy/date |
| POST /approve | Explicit landlord physical inspection, vacancy and condition-acceptance statement |

Baseline `/condition-report/ai-consent` now requires `no_identity_documents:true` for a grant and records disclosure `condition-ai-v2`. Legacy grants lacking this attestation do not authorize new comparison. Confirmation still does not grant AI permission.

## Frontend

New `MoveOutInspectionPanel.tsx`, `api/moveOutInspections.ts`, and `styles/move-out-inspection.css` extend the existing contract detail page. Existing My Tenants and rental-management views link directly to its anchor.

The panel supports labelled native photo selection/camera capture, explicit matching, original paired private images, timestamps, retakes preserving archived evidence, progress/polling, unchecked consent, text findings, landlord decisions/notes, independently discovered issues, recorded resolutions, vacancy, approval and event history. Successful AI findings cannot be erased through manual fallback. Completed reports remove editing actions. Desktop and 390px browser checks showed no horizontal overflow. Physical iOS/Android camera and HEIC conversion were not tested; uploads remain JPEG/PNG only.

Screenshots are in `output/condition-phase2-ui/`. These show synthetic evidence and an actual Gemini response, not real tenant photographs.

## Gemini configuration and durable processing

Actual tested model: **`gemini-3.5-flash-lite`**, REST **`v1beta/models/{model}:generateContent`**, temperature 0, constrained JSON, 45-second request timeout, prompt **`condition-comparison-text-v3`**. Model selection preserves `GEMINI_VISION_MODEL`, then existing `GEMINI_MODEL`, then the tested default. Credentials remain server-only.

Production comparator `moveOutVision.ts` is separate from Phase 1's synthetic feasibility prototype. It sends only selected paired image copies and room labels/IDs. Derived inference copies are EXIF-oriented, at most 1600 pixels on a side, JPEG quality 85; original stored evidence is untouched. Up to four pairs are batched per request with a conservative 19 MB JSON ceiling.

Backend validation rejects unknown fields, foreign room/photo IDs, unsupported categories, excessive text and change findings under an overall insufficient-evidence response. IDs are deterministically generated by the server and every observation requires human review. Empty findings are valid. The prompt treats photo text and labels as untrusted, excludes lighting-only findings, and prohibits cause, liability, repair-cost, deposit and confidence claims.

The worker downloads private evidence server-side, verifies stored-byte hashes, rechecks current authorized tenancy/ownership and both latest exact-snapshot permissions before transmission and publication, and fences writes by job lease, version, hash and pending state. Evidence replacement and manual fallback prevent older jobs publishing findings. Jobs recover expired five-minute leases, renew between batches, retry temporary failures at most three attempts with backoff, and leave failed/unavailable analysis usable for manual review. Queue claims use `FOR UPDATE SKIP LOCKED`; repeated completion does not duplicate findings or notifications. A terminal same-version job cannot leave a re-analysis request permanently pending.

Important protocol references checked: [Gemini structured output](https://aistudio.google.com/docs/structured-output), [image understanding](https://aistudio.google.com/docs/image-understanding), and [provider processing terms](https://aistudio.google.com/docs/terms). Operator configuration and the applicable paid processing arrangement require review before real-home use.

## Actual vision evaluation

Predeclared expected outcomes and authored-image hashes were saved before each run. This is a small, agent-reviewed qualitative feasibility exercise. It is not an independent human-labelled benchmark, and no accuracy percentage was manufactured.

The first Phase 2 prompt (`v2`) produced a tint-only false-positive finding. The complete v2 outputs and review remain in `output/condition-phase-two`. Prompt v3 explicitly excludes lighting/tint-only findings; its separate full repeat remains in `output/condition-phase-two-v3`.

| Case | Actual v3 result | Limits | Runtime |
| --- | --- | --- | ---: |
| Identical | Empty findings, no clear change | No false positive observed in this sample | 19.474 s |
| Lighting | Empty findings; tint recorded as limitation | v2 failed this case; one corrected repeat is not robustness proof | 18.931 s |
| Moved furniture | Request timed out | Also timed out in v2; recognition and false positives cannot be assessed | 45.042 s |
| Wall mark | One specific new visible wall-mark finding | No cause/liability asserted | 22.006 s |
| Obstruction | Limited comparison, no findings | Correctly avoided inventing hidden changes | 13.367 s |
| Multiple changes | Two findings cover both wall marks together and floor patch | All three authored features described, but wall marks grouped rather than fully separate | 24.815 s |
| No baseline | Actual database/API manual workflow completes | Not a live model sample; no comparison request | Not applicable |
| Model unavailable | Injected 503 fails after three attempts, remains manually reviewable | Explicit test double; not an observed provider outage | Not applicable |

Five valid v3 responses reported **12,445 prompt + 659 candidate = 13,104 total tokens**. Completed-response latency was 13.367–24.815 seconds, median 19.474 seconds. No usage was available for the timeout; missing usage does not establish zero billing.

The actual browser demonstration separately generated a valid wall-mark finding with v3, then completed review/approval/vacancy. Its final successful job runtime was **23.367 seconds**, with **2,488 prompt + 190 candidate = 2,678 total tokens**. It finished on attempt 2, approximately 64 seconds after enqueue including retry/scheduling; the prior failure reason was not retained, so it is not inferred. See `output/condition-phase-two/live-demo-evidence.json`.

## Bounding boxes

Automatic region display is **disabled**, following the Phase 1 decision gate. The production schema rejects region fields; text locations and paired originals remain fully reviewable. Original photos are never regenerated or altered to add markings. Phase 1's box validation/scaling tests remain, but do not establish real-world localization reliability. No camera-alignment overlay was added.

## Human approval and lifecycle

Evidence changes create the next input version and invalidate active analysis/permissions/reviews. AI observations are persisted separately from append-only human decisions. Only the frozen authorized landlord can review or approve; tenant approval attempts fail. Every AI finding must have a decision, including “unable to verify,” before acceptance. Confirmed issues and flagged manual observations enter `needs_review`; a documented resolution is required. Saving another finding's review cannot clear an unresolved manual issue.

Tenant vacancy is independently recorded and visible on the inspection and contract even while condition acceptance is disputed. It cannot be undone by rewriting a landlord note. Existing occupancy/billing eligibility is preserved until controlled final closure; reporting vacancy does not resume invoices for an expired legacy unconfirmed contract. Financial settlement remains distinct.

Landlord acceptance and tenant vacancy may happen in either order. Acceptance first produces `approved`; once both are present with the same date and the current eligible contract, one transaction records final inspection completion, `contracts.status='completed'`, `occupancy_state='closed'`, related renewed-chain closure, audit and notifications. Existing database triggers control listing release. AI completion, inspection creation, contract expiry and a dispute do not release the listing. Payment rows/receipts are not changed or marked paid.

The legacy closure endpoint cannot bypass an existing inspection. Continuing renewals prevent finalization. Review found and fixed a listing/root lock inversion; proposal, signing, inspection, worker publication and legacy closure now follow compatible listing → root → dependent-row locking. Real PostgreSQL also exposed and verified a fix for local DATE-to-UTC calendar shifts.

Notifications cover baseline review/confirmation, initiation, submission, analysis readiness/manual fallback, issues/resolution, tenant vacancy, landlord acceptance and completion. Unique event keys suppress duplicate delivery records. Messages contain no image URL or private personal details and link through the existing contract Notification Center.

## Privacy and evidence integrity

Authorization checks both current contract access and frozen baseline/inspection participants. Foreign contract/photo IDs, storage paths and query parameters fail before signing/downloading/buffering. Tables and provider output are private to the backend; browser roles cannot bypass application permissions. Private storage refuses a public evidence bucket. Signed URLs expire after 120 seconds and responses use private/no-store and no-referrer headers.

Uploads reuse Phase 1 decoding/size/pixel/EXIF/GPS protections and immutable object storage. Uploader-only retirement preserves original rows/objects and submitted snapshots. Ambiguous COMMIT acknowledgements preserve referenced objects. Hashes provide platform tamper evidence, not proof of an authentic original scene, capture location or independent notarization.

Image-processing permission and identity-free attestation are explicit and separate from baseline confirmation and future training/marketing reuse. No real homes, identity documents, payment/profile information or production users were sent to Gemini in this work. The product does not implement automatic identity-document detection/redaction; operator safeguards and honest user screening remain necessary before enabling real-home processing.

Retention remains the existing documented policy: review evidence for deletion 12 months after confirmed physical closure, subject to documented dispute holds; abandoned drafts after 90 days. Privileged audited deletion, backup expiry and orphan-object reconciliation still require operational implementation. Ordinary APIs cannot casually delete confirmed evidence.

## Verification

Final verification: **202/202 server tests and 32/32 client tests passed; server TypeScript and client production/demo builds passed.** The existing client bundle-size warning remains. See `output/condition-phase-two/validation.json` for command results. Coverage includes the full baseline-to-completion journey, actual authenticated multipart API calls, privacy, old/new participant access, version/lease fences, revocation, retries/timeouts/malformed JSON, no-change/multiple findings, unmatched photos labelled as unanalyzed, no baseline, retrospective baseline labels, manual issues/resolution, double approval, payment/listing preservation and existing expiry/renewal regressions.

Six checks additionally ran against a **fresh PostgreSQL 17 cluster on loopback**, with separate actual `pg.Pool` sessions, synthetic records and provider/storage test doubles:

1. Simultaneous duplicate landlord approvals complete once.
2. Evidence replacement racing approval has one winner; stale acceptance cannot succeed.
3. Concurrent claims, expired-lease recovery and stale-worker publication fencing.
4. Withdrawal blocks a claimed result.
5. Concurrent landlord acceptance and tenant vacancy finalize safely.
6. Renewal proposal versus final approval observes a real listing lock wait and rejects closure after the continuing renewal becomes visible.

Migration rehearsal applied all repository migrations to fresh isolated PostgreSQL/PGlite databases. No production schema was changed. Actual browser testing exercised live synthetic inference through the real routes/worker and both accounts; the separate repeatable fixture HTTP walkthrough passed 12 grouped checks. Mocked provider responses are identified as test doubles throughout.

## Remaining risks and production work

- Apply reviewed 022/023 migrations before running the new API/worker; the new worker assumes those tables exist. No automatic deployment/migration was performed.
- Verify new backend object-download behavior against staging Supabase and audit effective private bucket policies. Phase 2 tests used private disk/in-memory/fetch doubles; Phase 1's earlier hosted smoke is separate evidence.
- Review paid provider data handling, processing disclosure, lawful use and no-training safeguards before enabling `CONDITION_AI_PROCESSING_ENABLED`. Consent alone is not proof of those safeguards or absence of identity documents.
- Furniture handling remains unevaluated in the completed v3 set because of two timeouts. Real-home viewpoints, lighting, obstructions and subtle defects need a larger independently reviewed evaluation. Grouped changes may need manual separation.
- A slow or partially failed multi-batch attempt may repeat already processed pairs on retry. Successful final metrics are stored, but earlier failed-attempt reasons/partial usage are not a complete billing ledger.
- Retention/deletion/reconciliation jobs, backup expiry, shared multi-instance rate limiting and worker/queue monitoring remain operational tasks.
- Physical mobile-device camera/gallery and poor-network upload behavior remain unverified.
- The existing two-party closure model has no independent adjudicator or bounded escalation service. A tenant's vacancy declaration remains independently recorded, but an uncooperative party can delay final condition acceptance/contract closure. No arbitration or automatic financial resolution was invented; production dispute operations still need an explicit policy.
- The existing large client-bundle warning remains. Unrelated local Graphify, media, skills and scratch changes were left untouched.

## Demonstration and truthful claims

Complete commands, synthetic accounts, six-scene walkthrough, reset/resume and live/fixture distinctions: [demo guide](condition-inspection-demo.md).

Approved presentation wording:

> Nibash uses multimodal AI to suggest visible changes between rental-property photographs and organizes those suggestions for landlord review.

> Humans review the evidence, record physical vacancy and approve move-out. AI does not determine responsibility, repair costs or deposit deductions.

State explicitly that the evaluation and demo use authored synthetic images. The local database, private disk storage and users are simulations of production infrastructure. Live mode makes real Gemini requests; fixture fallback is precomputed and labelled. Do not claim all-damage detection, numerical accuracy, authentic-scene verification, reliable boxes, robust furniture handling or a production deployment.
