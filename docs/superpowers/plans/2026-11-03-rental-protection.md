# Rental protection implementation plan

**Goal:** Deliver a demonstrable protected agreement → confirmed installment → permanent acknowledgment → authorized tenant-management flow.

**Architecture:** Extend contracts; do not create tenancies. Keep existing payments as invoices and add actual receipt events underneath them. Store immutable snapshots and generated PDF bytes in private PostgreSQL records, with recoverable leased work. Use existing notifications and JWT authorization. All monetary decisions use PostgreSQL numeric.

**Constraints:** Preserve concurrent NLP/area changes. Additive migration only; never run old destructive migrations against a configured database. No deployment. No AI for financial rules or personal tenant data. No claimed legal signatures, registration or police verification.

## Audit

Existing: proposed/signed/completed contracts, tenant acceptance, owner listing authorization, numeric terms, monthly billing procedure, pending cash marking, landlord confirmation, PostgreSQL document-screening worker, trigger notifications, owner income pages and private property-document storage. No receipt PDFs, agreement version snapshots, installments or My Tenants page.

Defects: expiry cron releases occupied listings; active status remains in read queries; confirmation races; confirmation marks any payment as a paid deposit; new contracts allow unrestricted deposits; no continuing-tenancy identity or amendment history. Migration 016 already corrected monthly billing's status.

## Tasks in priority order

- [x] P0/P1: Write failing PGlite migration tests for lifecycle, immutable financial terms, historic review state, signed baseline, calendar anniversaries, ordinary deposit/advance validation and rent amendment acceptance. Add migration 018 and service integration. Lock listing and contract transitions. Preserve occupied listings after expiry. A dual-party move-out/settlement confirmation explicitly closes the relationship; renewals link their predecessor without restarting protection. Reject unexplained historical continuity.
- [x] P2: Write event/receipt tests: pending has no acknowledgment, partial/full and multiple installments, duplicate confirmation, reversal, snapshots, lease recovery and private access. Add payment events and immutable document snapshots; use existing invoice IDs/routes. Generate PDFs with PDFKit; private download checks party identity before returning bytes. No fake signatures. Existing signed records remain verification-needed; finalized documents only follow captured acceptance.
- [x] P3: Add scoped, paginated My Tenants API and responsive page; reuse contract detail for relationship overview, payments, documents, revisions and DMP status. DMP statuses are self-reported; no sensitive identity fields, collection, export or submission. Tenant can view information and file a correction request using existing notifications.
- [x] Verify full backend tests, frontend tests/build, backend build and real migrations in embedded PostgreSQL. Exercise synthetic HTTP flow with JWTs. Independent review focused on isolation, immutability, concurrency and historical handling; correct material findings. Commit only this task's files. Write complete report and reproducible demo.

## Validation commands

`cd server; npm test` (isolated PGlite and unit suites; excludes legacy suites which mutate DATABASE_URL).

`cd server; npm run build`

`cd client; npm test` and `npm run build`.

## Deliberate MVP boundaries

Optional AI explanations skipped until P1–P3 are stable. Statutory exceptions and Controller approval collection unsupported. Registration/signature formalities require human legal review. DMP official form fields will not be invented if the authoritative form cannot be retrieved. No retrospective certification of historical contracts/payments. Production retention, backups and regulatory review remain operational requirements.
