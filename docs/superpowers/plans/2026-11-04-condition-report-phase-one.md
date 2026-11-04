# Condition report Phase 1 implementation plan

**Goal:** Private, versioned, mutually confirmed photographic condition records inside existing contract pages; an independent synthetic Gemini feasibility gate.

**Architecture:** Add four tables (reports, rooms, photos, immutable events). Resolve renewals to the existing root contract. Serialize mutations with the root/report row locks and require the caller's expected version. Preserve submitted snapshots in events; confirmations bind actor, version and canonical SHA-256. A changed submitted report returns to draft with a new version. Confirmed reports and their evidence are immutable through application and database guards. No new tenancy, closure, settlement or availability logic.

**Scope:** Inline execution under the user's explicit proceed instruction. Preserve the dirty starting source snapshot in an isolated managed worktree. Do not deploy, run remote migrations, invoke existing document-verification jobs, or alter payments/NLP/areas/legal workflows.

## Deliverables and verification

- [x] Inspect contract acceptance, renewal, closure, storage, Gemini, queues, notifications and UI; verify the working tree rather than relying on the graph alone.
- [x] Add tests before implementation for SQL installation and privileges, service authorization, cross-contract access, snapshot invalidation, duplicate confirmation, immutable photos and locked reports, replacement and concurrent stale writes.
- [x] Add migration 021 and private bucket setup SQL. Foreign keys restrict deletion; browser roles have no access. No automatic relisting or AI queue integration.
- [x] Add image processing with real decode, JPEG/PNG signatures, 8 MiB/24 megapixel limits, single frame, EXIF orientation correction, metadata stripping, canonical stored-byte SHA-256. Preserve removed photo records and immutable storage objects.
- [x] Add contract-scoped APIs with authenticated authorization before multipart parsing, strict Zod validation, expected version and hash, 120-second signed URLs, no caller-provided storage paths, private/no-store responses.
- [x] Add an accessible responsive contract panel: current-condition warning, actual recording date, rooms, file selection and cancellation, notes, previews, submit, exact snapshot confirmations and audit history. AI consent is explicit, optional, snapshot-bound and revocable; production inference remains disabled.
- [x] Add a synthetic vision CLI with six predeclared cases, strict structured JSON and validated boxes, raw responses, timings, usage, per-case observations and honest blocked results. Try the configured economical model only; no automatic expensive fallback.
- [x] Run isolated PostgreSQL migration/service/HTTP tests, lifecycle regressions, client interaction tests, TypeScript builds and review. Record limitations and exact Phase 2 integration instructions.

## Decisions and alternatives

Reports are independent evidence records linked to existing roots, rather than new tenancy rows. Four normalized tables retain audit history without separate confirmation and job tables in Phase 1. Server-mediated authorization and short-lived signed URLs follow the existing private document architecture. A production AI pipeline now would create unvalidated localization and processing risks, so only a local synthetic prototype calls Gemini.

Move-in states are `draft`, `submitted`, `confirmed`. Physical move-out remains governed by existing `occupancy_state`. Future inspection states belong to an inspection record in Phase 2, not to contract status. Missing baselines return null and allow manual future documentation. A historical report is always labeled `current_condition` using the actual server recording date, never a fabricated move-in date.

Retention policy: active records remain available during occupancy; review for deletion 12 months after confirmed physical closure, with documented dispute holds and backup expiry; abandoned unsubmitted drafts after 90 days. Phase 1 has no automatic destructive purge; a deployment owner must implement and verify the retention job before production use. No reuse for marketing or training. Paid provider terms and processing review are prerequisites to any future real-home inference, regardless of consent.
