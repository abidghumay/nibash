# Nibash condition inspection Phase 2 implementation plan

User specification: the attached Phase 2 brief, explicitly authorizing implementation in the existing codebase. No deployment or production configuration changes.

## Design and decision gate

Reuse the confirmed root-tenancy baseline, private evidence normalization/storage, JWT authorization, Notification Center, and PostgreSQL lease/retry job pattern. Keep separate move-out tables; never edit Phase 1 evidence. Phase 1 had a moved-table false positive and speculative crack descriptions. Ship text-only comparison and side-by-side review; leave automatic bounding boxes disabled.

Evidence edits increment an inspection version. Submission hashes an immutable input snapshot. Both parties consent to that exact input and the confirmed baseline before an operator-enabled worker sends image bytes to Gemini. Jobs fence writes by lease, version, hash and pending state. Manual review works without the provider, consent, or a baseline.

Landlord observations/review remain distinct from AI output. Tenant vacancy and landlord acceptance are separate auditable actions; completion uses the existing controlled contract/occupancy rules and preserves payments. A disputed condition does not rewrite recorded vacancy or calculate liability. Expiration/analysis/initiation cannot release a listing.

## Work units and verification

- [x] Backend: migration 022, move-out service/router, contract mounting and closure bypass guard. First add isolated PostgreSQL journey tests proving creation, privacy, version rejection, manual submission, review gating, tenant vacancy, duplicate approval, dispute resolution, and payment/listing preservation. Run with `node --import tsx --test src/services/moveOutInspections.integration.test.ts`.
- [x] Model: strict schema and tested `v1beta generateContent` model configuration in `moveOutVision.ts`; paired image IDs must be from submitted evidence. Add tests before implementation for empty findings, unsupported IDs, abstention, untrusted image text instructions, timeout and malformed provider output. Normalize only derived inference copies; preserve stored originals.
- [x] Jobs: migration 023 and `conditionAiJobs.service.ts`, following existing lease queue with bounded retries, recovery, exact consent checks, evidence integrity checks and manual fallback. Use isolated PostgreSQL tests for stale leases/versions, duplicate completion, revoked consent and permanent/temporary failures. Reuse startup worker pattern.
- [x] Client: mobile-friendly `MoveOutInspectionPanel` in contract details, explicit baseline matching, private previews, native camera/upload inputs, processing state, consent, per-finding landlord review, observations, vacancy and approval. Add behavior tests first and build with `npm run build`.
- [x] Demonstration: localhost-only persistent synthetic database and private local evidence; real synthetic inference and explicitly labelled fixture fallback modes. Record expected outputs before live evaluation and report failures honestly. Document exact demo commands and accounts.
- [x] Integration review: inspect diffs, run all isolated server/client tests and both builds; apply migrations in isolated PostgreSQL. Inspect desktop/mobile rendering if local browser tools are available. Record evidence and remaining production risks in `docs/condition-inspection-phase-two.md`.

## Shared interfaces

Route base `/api/contracts/:id/move-out-inspection`. GET returns `{inspection,baseline,eligible,ai_analysis_enabled,analysis_blocked_reason}`. Evidence routes use `version`; `/submit` freezes inputs; `/ai-consent` binds actor to `version/hash`; `/analyze` enqueues only after both consent gates. `/reviews`, `/observations`, `/resolve`, `/vacancy`, `/approve` preserve event history. Private URL requests accept database photo IDs only.

Tables: `move_out_inspections`, `move_out_rooms`, `move_out_photos`, `move_out_events`, and `condition_analysis_jobs`. Analysis result uses `{comparisonStatus,summary,findings,limitations}` with server-bound image identities and review-required observations. Job metrics store model, latency and provider token usage where supplied. No model numerical confidence, costs or liability fields.
