# Nibash Phase 1: condition records and vision feasibility

Recorded November 4, 2026, Bangladesh time. No deployment, remote migration, real-home inference or real Supabase photo upload was performed.

**Later rollout:** The owner subsequently authorized integration and production deployment. See [the combined condition/payment rollout](condition-payment-production-rollout.md) for the applied migrations, real storage smoke, five PostgreSQL multi-session tests, combined 179-server/31-client validation and deployment evidence. The implementation record below describes the original isolated Phase 1 completion.

Work is preserved in the attached isolated checkout:
`C:/Users/Abid/.codex/worktrees/condition-report-phase-one/nibash`

The original checkout was left untouched. The isolated checkout includes a copy of the uncommitted payment/contract work that was present when this task started. That copied work is context, not a Phase 1 payment change. Review the Phase 1 file list below rather than treating every worktree diff against HEAD as this feature.

## 1. What already existed

Current source inspection, after a Graphify query, confirmed:

- `contracts.status` supports `proposed`, `signed`, `renewed`, `completed`. Migration 018 maintains `root_contract_id`, `previous_contract_id`, rental protection and immutable acceptance history.
- Tenant acceptance changes a reviewed proposal to signed. Renewal requires the same tenant/listing, next-day continuation and protected rent rules.
- `occupancy_state` supports `unconfirmed`, `upcoming`, `occupied`, `move_out_pending`, `closed`, `continued`. Legal expiry does not prove vacancy.
- The current closure service already requires both parties to confirm the same move-out date, inspection note and settlement note. Its completed/closed transition releases a listing through an existing database trigger. The daily cron does not expire contracts into vacant listings.
- Rental-management APIs and the My Tenants dashboard already exist. The dashboard links to contract details, so it reaches this new panel through the existing route.
- Private verification documents use a dedicated Supabase bucket, backend authorization, short-lived signed URLs and service-role storage calls. Public listing images use a different bucket.
- Gemini document triage already uses server-side `GEMINI_API_KEY`, `GEMINI_MODEL` and REST `v1beta generateContent`.
- A PostgreSQL `document_ai_jobs` queue already supports leases, `FOR UPDATE SKIP LOCKED`, retries and version fencing. It was inspected, not reused for private-home analysis in Phase 1.
- Existing notifications, rental documents, payments, receipts, NLP search and dynamic areas were preserved.
- No earlier condition-report implementation was found. The starting snapshot passed 161 server and 29 client tests.

Relevant existing files: `server/src/services/contract.service.ts`, `rentalManagement.service.ts`, `documentStorage.service.ts`, `documentAiJobs.service.ts`, `cron/jobs.ts`, `db/migrations/018_rental_protection.sql`, `client/src/pages/MyTenantsPage.tsx`.

## 2. What was implemented

A private condition-record panel inside the existing contract detail page. Either contract party can create a draft, add rooms, upload photographs and human notes, submit a canonical snapshot and confirm that exact version.

The report resolves renewals to the existing root contract. Accepted renewal pages read the same baseline; no duplicate tenancy or competing lifecycle was added. An accepted, physically open chain is required to create or edit. Historical and completed records remain readable by authorized parties.

Historical tenancies default to **Current condition record** when the root start date precedes the server's Bangladesh recording date. The actual creation date and each photo upload date are visible. There is no backdating control. This does not assert original move-in condition. Missing evidence is returned as `report:null`, never synthesized.

Move-in states are `draft → submitted → confirmed`. A submitted edit creates the next draft version. A confirmed report cannot be reopened through these APIs.

Phase 1 creates no move-out inspection, approval, automatic comparison, financial decision or listing transition. For Phase 2, the intended inspection states are:

| Logical state | Future inspection representation |
|---|---|
| Not started | No inspection record |
| Awaiting photographs | `awaiting_photos` |
| AI analysis pending | `analysis_pending`, only if permitted evidence and consent exist |
| Awaiting landlord inspection | `awaiting_inspection`; also reached without AI when no baseline exists |
| Approved | `approved`, explicit human action |
| Needs further review | `needs_review`, without inferring liability |
| Completed | `completed`, physical inspection completion only |

These are future inspection states, not new `contracts.status` values.

## 3. Database changes and migrations

Additive `db/migrations/021_condition_reports.sql` adds four tables:

- `condition_reports`: root contract, type, retrospective/move-in label, frozen participant IDs, actual recording time, version, state, submission/lock times, canonical hash.
- `condition_rooms`: room names and deterministic display order.
- `condition_photos`: private path, original filename, validated MIME, normalized dimensions/size/hash, uploader/time, human notes and removal time. Composite foreign keys prevent a room from another report being attached.
- `condition_events`: append-only actions, actors, times, versions, submitted snapshots, confirmations and optional consent changes. Partial unique indexes prevent duplicate confirmation and submission events for a version.

Foreign keys use deletion restrictions. Confirmed reports reject ordinary updates/deletion. Submitted/confirmed evidence cannot be changed directly; image identity fields remain immutable even in draft. Removed evidence rows and immutable objects are retained. Events cannot be edited or deleted. Browser roles have no table, sequence or trigger-function access, and RLS is enabled.

The migration extends the current notification-kind constraint without replacing its existing permitted kinds.

`db/supabase_condition_storage.sql` separately provisions a private `condition-evidence` bucket with an 8 MiB JPEG/PNG limit. Transactional, repeatable restrictive policies prevent browser access even if an old permissive policy covers all buckets. This was tested against simulated Supabase schemas in isolated PostgreSQL; it has not been applied to hosted Supabase.

All application migrations, including the copied payment migration 020 and new 021, were applied to an isolated PGlite PostgreSQL engine. No live database was modified.

## 4. API routes and frontend screens

Base: `/api/contracts/:id/condition-report`.

| Method and suffix | Behavior |
|---|---|
| GET / | Authorized current report, rooms, active/archived photo metadata, events, confirmations and consent state |
| POST / | Create or return the root baseline |
| POST /rooms | Add room; body `{version,name}` |
| POST /photos | Multipart `version`, `room_id`, optional `notes`, one `photo` |
| PATCH /photos/:photoId | Update notes; body `{version,notes}` |
| POST /photos/:photoId/remove | Retire from current version; body `{version}`; original remains |
| GET /photos/:photoId/url | Issue 120-second authorized private URL |
| POST /submit | Freeze a submitted snapshot; body `{version}` |
| POST /confirm | Confirm exact snapshot; body `{version,hash}` |
| POST /ai-consent | Optional future consent/withdrawal; body `{version,hash,granted}` |

Routes use existing JWT/revocation authentication. Strict Zod input validation rejects unknown fields, invalid IDs, arbitrary storage paths and unexpected query parameters. Authorization happens before multipart buffering. Requests are limited to 120/minute/IP per process through the existing limiter.

`client/src/components/ConditionReportPanel.tsx` is mounted on `ContractDetailPage.tsx`. It includes rooms, private thumbnails/full-photo links, note editing, file selection/cancellation, submission, reviewed-snapshot acknowledgment, both confirmations/timestamps, canonical hash, archived snapshot review and privacy/consent controls.

Collapsed historical snapshots do not mount image previews. A session/contract/photo-specific in-memory cache deduplicates private URL requests for 105 seconds; it does not persist signed URLs. Expired previews offer an explicit access refresh.

The panel follows existing rental-card styling, labels controls, uses native checkboxes/details, preserves visible keyboard focus, and supports narrow layouts. `client/tests/fixtures/condition-report-preview.html` is a local-only synthetic visual fixture and is not a production route or a second application.

## 5. Storage authorization model

Only the backend holds the service-role key. A caller supplies a contract ID and database photo ID; the server finds the stored path only after checking the contract parties and report membership. The API never returns storage paths. Cross-contract and unrelated landlord/tenant access is rejected before signing or storage calls.

Every upload and URL request fails closed if the dedicated bucket is public. Object names are generated UUID paths; uploads explicitly disable upsert. No public photo URL is created. Link responses use `Cache-Control: private, no-store` and no-referrer headers. Signed links remain bearer links until expiry and must not be shared.

Sharp fully decodes JPEG/PNG bytes after signature/MIME agreement, rejects malformed or multiple-frame images, enforces 8 MiB, 64–8000 pixels per side and 24 megapixels, rotates EXIF orientation, strips metadata including GPS, and hashes normalized stored bytes. JPEG normalization is lossy; the hash identifies stored evidence, not the original camera file. WebP/HEIC are intentionally unsupported for uploads initially.

Failed transactions check for a committed image reference before deleting an uploaded object. Ambiguous COMMIT acknowledgment failures preserve committed evidence; uncertain cleanup retains the object for operator reconciliation. Process crashes can still leave unreferenced objects, requiring a deployment reconciliation job.

The stored filename, timestamp, hash and browser upload action do not establish authenticity, capture location or legal certification.

## 6. Baseline confirmation

Mutations acquire the root lock, then read eligibility under a fresh READ COMMITTED statement and lock the report. Expected-version mismatches return 409. A submitted edit increments the version, returns to draft and clears the active submission hash. Old events/snapshots/confirmations remain in history but no longer count toward the new version.

Submission requires at least one photo in every room. A deterministic, recursively key-sorted JSON snapshot includes report identity, participants, actual recording date, version, room order and all active photo metadata/notes/hashes. SHA-256 covers that snapshot; submitted snapshots are preserved in immutable events.

Each confirmation binds the actor to the version and hash. The server recomputes the snapshot hash before accepting it. Duplicate confirmations are idempotent. Two distinct participant confirmations lock the report atomically; SQL guards independently reject locked evidence changes.

The browser clears its review checkbox whenever version/hash changes. Neither successful AI analysis nor optional consent confirms or approves a report.

## 7. Actual Gemini model/API tested

Six actual requests used the already configured **`gemini-3.5-flash-lite`**, REST **`v1beta/models/{model}:generateContent`**, on November 4, 2026. No expensive-model fallback was used. Inputs were project-authored synthetic room illustrations, two labeled inline PNG images, a room name and synthetic baseline notes. No identity documents, profiles, phone numbers, payments or real-home photographs were sent.

The independent CLI is `server/src/scripts/evaluateConditionVision.ts`, backed by `conditionVision.ts`. It saves all fixture images and expected outcomes before inference, then records model output, raw provider response, usage and runtime per case. It also accepts a synthetic pair with `--pair`, `--room` and optional `--notes`.

Official documentation checked:

- [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding): multiple image inputs and normalized detection boxes ordered `[ymin,xmin,ymax,xmax]` in 0–1000.
- [Structured output](https://ai.google.dev/gemini-api/docs/structured-output): JSON schema support.
- [Configured model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): multimodal image input.
- [File limits](https://ai.google.dev/gemini-api/docs/file-input-methods): current general guide says 100 MB inline; image-understanding guidance also states 20 MB total. This prototype conservatively enforces 19 MB total JSON including base64, avoiding that documentation ambiguity.
- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): project/model-specific RPM, TPM and RPD; actual account quotas must be checked in AI Studio. The fixture success does not establish a production quota.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing): checked standard rates for this model were $0.30/M input tokens and $2.50/M output tokens. Logged usage was 14,274 input and 646 output tokens, approximately **$0.00590** at those rates. This is a rate-based estimate, not a verified charge or a real-photo cost forecast.
- [Provider terms](https://ai.google.dev/gemini-api/terms): processing and training treatment depend on service configuration. Real-home use requires a paid, reviewed configuration and operator safeguards.

Calls took 2.842–7.615 seconds each; total recorded inference runtime 30.689 seconds. These are observations from this run, not latency guarantees.

## 8. Six actual comparison cases

Inputs, expected outcomes, full responses and per-case manual review are in `output/condition-vision/expectations.json` and `results.json`. `fixture-pairs.png` shows all inputs side by side.

| Case | Predeclared expectation | Actual response and review | Runtime | Region / abstention |
|---|---|---|---:|---|
| Identical | No differences | Empty differences; comparable | 3.203 s | No box, as expected; abstention unnecessary |
| Different lighting | No surface change | Correctly treated exposure/color shift as lighting | 7.615 s | No box, as expected |
| Chair moved | Chair moved right; no damage | Chair identified; **false positive: stationary table also described as moved** | 2.842 s | Chair box aligned; table change rejected |
| New wall mark | Central brown wall stroke | Visible mark found; “mark or crack” does not establish an actual crack | 7.360 s | Region aligned; comparable |
| Obstruction | Abstain rather than invent hidden changes | `comparable:false`, empty differences, obstruction explained | 5.899 s | Correct abstention; no box |
| Multiple differences | Two wall marks and floor patch | All three visible regions found; “crack” wording overstates what drawn strokes establish | 3.770 s | All three regions aligned; comparable |

No intended observable region was missed in the unobstructed cases. Hidden conditions in the obstructed case cannot be assessed. The moved-table claim was incorrect. These six deterministic illustrations are an API smoke test and localization experiment, not an accuracy benchmark or evidence that real damage detection works.

## 9. Highlighting recommendation

**Phase 2 should begin with neutral descriptions and explicit human inspection, with automatic box display disabled.**

The parser rejects wrong coordinate counts/order/range, non-integers and zero/negative-area regions. Unreliable comparisons must return no differences. Returned regions were visually reviewed in the second image; scaling was tested mathematically and rendered at 800×600 and 400×300 in `reviewed-regions.png`. Only visually corresponding chair/mark regions were drawn in that diagnostic artifact; the table box was excluded.

A valid box around a real object does not make its claimed change true. The table false positive and speculative crack descriptions make automatic highlighting unjustified on this evidence. No production UI draws AI boxes, and no provider response affects approval, liability, money or listing availability.

## 10. Verification

**Final results: 179/179 server tests and 30/30 client tests passed; server TypeScript and client production builds passed.** The client retains its existing large-JavaScript-chunk warning. Independent security re-review found no remaining must-fix findings after the documented fixes.

Final command logs are stored locally in `server/condition-final-tests.log` and `client/condition-final-tests.log` (ignored log files). Machine-readable verification is summarized in `output/condition-vision/validation.json`.

Coverage includes unauthorized tenant/landlord access, cross-contract image IDs, malformed/MIME-mismatched/oversized/over-dimension images, EXIF orientation and metadata removal, preserved replacement evidence, stale competing edits, version invalidation, both confirmations, duplicate confirmation, wrong hashes, direct locked SQL mutations, append-only audit events, root renewal reuse, missing baselines, ambiguous COMMIT failure and refreshed eligibility after root-lock acquisition. The bucket test defeats a deliberately broad legacy RLS policy for both browser roles.

Client tests cover absent-baseline wording, actual recording limitations, file selection/cancellation without upload, confirmation gating/version reset, optional unchecked AI consent and deferred history previews. Existing rental/payment/NLP/area/document regressions were retained.

Browser QA exercised the synthetic fixture, private preview loading, review acknowledgment, dual-party locked state and removal of editing controls. At a 615-pixel viewport the document width was 607 pixels, without horizontal overflow. Physical Android/iOS camera/gallery behavior and real-device upload were **not** tested.

PGlite runs PostgreSQL SQL, constraints, triggers and RLS in isolation. Its pool adapter serializes connections, so the competing-edit test is **not** a multi-session PostgreSQL lock test. Fault injection covers stale-version behavior and state changes after lock acquisition; actual concurrent PostgreSQL closure/edit and simultaneous-confirmation sessions still need staging verification.

## 11. Privacy and deployment limitations

Production inference is disabled regardless of consent. Optional consent and withdrawal are append-only, version/hash-bound and disclosed. Confirmation does not grant AI consent. There is no photo reuse for training or marketing. The prototype rejects requests lacking the explicit synthetic-only flag.

Deployment prerequisites:

1. Apply migration 021 after the repository's existing migrations, including any reviewed payment migration dependency.
2. Run `db/supabase_condition_storage.sql` in the intended Supabase project; verify private visibility and effective browser RLS, including existing service roles and bucket policies.
3. Install locked server dependencies, including Sharp's platform binaries. Supported Sharp packages require Node 20.9+; use the project's supported current Node runtime.
4. Configure server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never put the service key in Vite variables. Existing JWT/database configuration remains required.
5. Verify authenticated upload/sign/download against staging Supabase. Storage tests here used synthetic in-memory storage and a simulated schema; hosted Supabase was not modified or exercised.
6. Implement operator-controlled storage reconciliation, deletion/dispute holds and backup expiry before production rollout. Policy: review evidence 12 months after confirmed physical closure; abandoned unsubmitted drafts after 90 days. Locked evidence cannot be casually purged through ordinary APIs; use an audited privileged retention procedure. No indefinite-storage promise is made.
7. Review provider processing terms, paid/no-training configuration, lawful basis, disclosure, deletion and personal-document redaction procedures before enabling any real-home inference. Both-party consent is necessary but not sufficient.
8. Run real PostgreSQL concurrent-session tests and real mobile device QA. The existing in-process rate limiter should be replaced or backed by shared infrastructure for multiple API instances.
9. Freeze participant IDs require an explicit reviewed handover if property ownership or contract parties change; automatic reassignment of historical evidence is intentionally unsupported.

The client build retains its existing large-chunk warning. No new final move-out workflow, closure requirement or relisting behavior was installed. Existing closure remains independent of these condition records.

## 12. Exact Phase 2 integration instructions

1. Reference the existing root baseline by `condition_reports.id`, confirmed `version` and `integrity_hash`. Read the immutable submitted snapshot from `condition_events.action='submitted'`. Preserve the `current_condition` limitation when presenting comparisons.
2. Introduce a separate inspection record linked to the current contract and baseline version, with the inspection states above. Reuse the existing contract root; do not add another tenancy table or change contract expiry into vacancy.
3. Add private move-out uploads using the same decoding/storage authorization rules. Match each to an explicit baseline photo ID and room. If no confirmed baseline exists or views are unsuitable, skip AI and route to manual documentation.
4. Before enqueueing and again before provider transmission, require current affirmative consent from both parties for **both exact report snapshots**, plus the operator processing safeguard flag. The latest consent event per actor/version/hash wins; withdrawal blocks queued jobs. A new report version requires fresh consent.
5. Extend the inspected PostgreSQL durable-job pattern into a condition-comparison job table: lease token, upload/report version fencing, retry schedule, bounded attempts and `FOR UPDATE SKIP LOCKED`. Do not place home photos in identity-document jobs or reuse their prompts/profile fields.
6. Implement a production comparator separately from the synthetic-only function. It may receive only the selected photo bytes, room name and permitted human notes. Never add NID/profile/payment fields. Do not send unredacted identity documents visible in photos. Keep provider bodies, photo bytes, signed URLs and secrets out of logs.
7. Validate every model response with the strict schema and preserve raw response/version/model/prompt metadata in private storage for audit. Stale results cannot overwrite newer evidence. Failed/abstained jobs go to human inspection. No AI result changes the contract, payments or listing.
8. Start with description-only suggestions. Enable any future box display only after larger independently reviewed realistic tests cover viewpoint changes, lighting, occlusion, object movements and false positives. A user must be able to reject a suggestion without implying liability.
9. Add explicit landlord inspection actions for approval or further review. Analysis completion merely changes the inspection to awaiting human inspection. Any financial settlement remains a separate workflow.
10. Integrate completed physical move-out with the existing dual-party closure service only after Phase 2 requirements are agreed. Do not automatically call `closeRental` on analysis completion, legal expiry, submission or a landlord disagreement.
11. Test concurrency with two actual PostgreSQL sessions, authorization on every image, consent withdrawal during queued/running jobs, lease expiry, stale response fencing, missing-baseline manual flow, mobile uploads and the existing full lifecycle suite.

## Reproduce locally

From the isolated checkout:

```powershell
cd server
npm ci
npm test
npm run build
npx tsx src/scripts/evaluateConditionVision.ts --synthetic --out ../output/condition-vision-rerun
# Optional independently supplied synthetic pair:
npx tsx src/scripts/evaluateConditionVision.ts --synthetic --pair C:/fixtures/before.png C:/fixtures/after.png --room "Bedroom" --notes "Clean wall" --out ../output/condition-vision-pair
cd ../client
npm ci
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 5187 --strictPort
```

Open the local synthetic fixture at `http://127.0.0.1:5187/tests/fixtures/condition-report-preview.html`. It mocks APIs and never connects to the backend. The actual feature is on the authenticated contract detail page after database/storage setup. Manual reviews recorded for this run do not apply to new model runs automatically.

### Phase 1 file list

New production files: `server/src/services/conditionReports.service.ts`, `conditionImages.ts`, `conditionStorage.service.ts`, `server/src/routes/conditionReport.route.ts`, `client/src/api/conditionReports.ts`, `client/src/components/ConditionReportPanel.tsx`, `client/src/styles/condition-report.css`, migration 021 and bucket SQL.

Small existing-file integrations: `server/src/routes/contract.route.ts`, `client/src/pages/ContractDetailPage.tsx`, `server/package.json` and its lockfile (Sharp only).

Independent prototype: `server/src/services/conditionVision.ts`, `server/src/scripts/evaluateConditionVision.ts`. Tests: `conditionReports.integration.test.ts`, `conditionImages.test.ts`, `conditionHttp.integration.test.ts`, `conditionBucket.integration.test.ts`, `conditionVision.test.ts`, `client/tests/conditionReport.test.tsx`. Synthetic preview fixtures and `output/condition-vision/` preserve reproducible inputs, actual outputs, diagnostic review images and UI evidence.
