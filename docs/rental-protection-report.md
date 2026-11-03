# Nibash rental protection implementation report

Release update, 3 November 2026: the implementation below was subsequently merged to production `main`, migrations 018 and 019 were applied after a successful private restore rehearsal, and frontend/API checks passed. See [the production rollout record](rental-production-rollout.md). References below to pending deployment or dependency advisories describe the original implementation stage; the rollout record supersedes them.

Hackathon extension prepared November 3, 2026 for the November 5, 10:00 PM Bangladesh deadline. Original marketplace, contributors’ attribution, search implementation, dynamic areas and AI document screening are preserved. Changes are on `codex/rental-protection`; nothing was deployed or applied to the configured database.

## A. Existing functionality discovered

The application already had owner/tenant/verifier roles, applications, proposed/signed/completed contracts, numeric agreement terms, tenant acceptance, rent invoices, cash marking, owner confirmation, income reporting, inbox notifications and a PostgreSQL-backed document-screening worker. Private storage existed for listing-verification documents. There was no installment receipt ledger, agreement-PDF version system, rent revision workflow or My Tenants view.

Migration 016 had already fixed monthly billing to use `signed`. Tenant lookup and income still referenced nonexistent `active`; the expiry cron completed contracts and a trigger released their listings. Payment confirmation was not transactional and incorrectly marked the security deposit paid after any confirmed payment. Contract proposal allowed unrestricted security deposits.

## B. Implemented functionality and boundaries

| Feature | Delivered behavior |
| --- | --- |
| Rent protection | Signed baseline, original rent, effective tenancy start, 24 calendar month anniversary, explicit historical verification status, owner-scoped proposals, tenant acceptance/rejection, immutable amendment history, exact numeric future billing. |
| Continuing rentals | Renewals link existing contracts and retain their original root, protection dates and credit history. Duplicate/open occupancy blocks a purported new tenancy. Ownership changes preserve protection. A new baseline requires actual dual-party closure of prior occupancy. |
| Financial restrictions | New ordinary deposits default to zero and are blocked server-side and in SQL. Ordinary advance is capped at one month. Unknown fee fields are rejected; mandatory recurring fees cannot change through a rent revision or bypass renewal checks. Existing historical deposits remain visible without certification. |
| Advance accounting | Confirmed advance is allocated through an immutable credit ledger, carried across renewals and deducted from outstanding rent. It is counted once as received money. Allocation avoids pending cash claims. Reversals preserve original entries and recalculate affected balances. |
| Payment documents | Actual confirmed installments issue individual permanent electronic acknowledgments with balances, issuer attribution, transaction references and private PDFs. Pending claims issue none. Reversals create linked documents. |
| Agreements | Owner proposal captures a clearly identified draft; tenant acceptance captures an accepted agreement. Accepted rent revisions create amendment documents. Prior versions are retained. |
| Lifecycle | Expiry does not release a property. Move-out date, inspection, settlement and matching confirmations from both parties are required for closure. Existing money and documents remain accessible. |
| My Tenants | `/owner/tenants`: scoped paginated current/upcoming/former relationships, rent, due status, dates and DMP preparation. Existing contract detail combines contact/occupancy information with agreements, installments, notifications and preparation tracking. |
| DMP preparation | Authorized existing contact/property information, official links, self-reported status/date/reference and tenant correction requests. No identity images, full identity-number serialization, household collection, export or automated submission. |
| Legal provenance | Typed source registry distinguishes statutes, official guidance, Nibash policy, verification status and applicability assumptions. |

Deliberately unsupported: Controller-approved exceptional collection; retrospective certification of old rent history; administrative historical-baseline verification; arbitrary non-rent amendment editing; automated CIMS integration; legally certified signatures/receipt forms/lease registration; optional AI clause explanations. Historic agreements and paid records are not retroactively represented as newly accepted or verified documents. Existing schema supplies property title, floor, area and city rather than a complete street/unit postal address.

## C. Architecture

### Database

Apply only new migrations **018 then 019** to an existing database already at 017. Both use transactions and preserve existing financial values and historical deposits. Do not replay old migrations 001–004 against existing data: those older files contain destructive table drops.

Contracts remain the rental relationship. Added fields establish root/predecessor links, original rent/protection history, acceptance timestamps and separate occupancy/closure state. Added `renewed` preserves predecessor agreements while allowing the successor to begin later.

New tables: `rent_revisions`, `rental_audit_events`, `payment_events`, `payment_reversals`, `advance_allocations`, `rental_documents` and `dmp_preparation`. They extend existing contracts/payments without another tenancy or user-profile table. Existing unknown payment categories are labeled historical; new invoices distinguish rent and permitted advance.

Billing is unique by continuing contract root and calendar month, so a midmonth renewal cannot issue a second full monthly invoice. It uses accepted effective rent at invoice creation. Existing invoice amounts are never recalculated. This MVP uses whole monthly invoices; it does not implement proration. Accepted midmonth revisions affect newly generated invoices and later billing, while previously issued invoices retain their original amount.

Advance allocation, claims, confirmation and reversal serialize on the continuing root before invoice locks. Confirmed payment events and their snapshots are immutable. Database uniqueness enforces one acknowledgment per confirmation event and one correction per reversal. Income reads confirmed, unreversed events plus legacy confirmed payments, excluding invoices settled through already-counted advance credits.

### APIs and authorization

Existing contract and payment URLs are retained. Contract creation now locks the listing and validates application/continuity in the transaction; acceptance is atomic. Monthly catch-up runs after acceptance commits, avoiding cross-contract signing locks. The daily job recovers billing failures.

New authenticated endpoints under `/api/rental`:

- `GET /tenants?page=1&limit=20&group=all|current|upcoming|former`
- `GET /contracts/:id`, `GET /rules`
- `POST /contracts/:id/revisions`, `PATCH /revisions/:id` with explicit acceptance/rejection
- `POST /events/:id/confirm`, `POST /events/:id/reversal`
- `GET /documents/:id/download`
- `PATCH /contracts/:id/dmp`, `POST /contracts/:id/correction`, `POST /contracts/:id/close`

Every relationship lookup is scoped to the tenant or current listing manager. Downloads additionally retain access for the original recorded issuing landlord. Another landlord receives 403, including guessed document IDs. List serializers omit NID/passport data and passwords. Existing inbox recipient authorization remains in use. Supabase browser roles lose table/function/sequence access to the financial extension; private tables also enable RLS. The server requires an appropriately restricted trusted database connection able to access these records.

Old full-invoice confirmation still works for its original unambiguous cash flow. Partial or later claims require the specific event confirmation route, preventing a retry from confirming the next installment. Tenant claim request keys are idempotent, including retries where amount was omitted.

### Documents and worker

The existing AI job table is specific to listing documents and upload versions, so it is not reused for agreements or receipts. Rental document rows act as a durable PostgreSQL work queue using the same leased-work approach: `FOR UPDATE SKIP LOCKED`, a lease token, expiry reclamation and retry backoff. Rendering failure retains the snapshot. An expired worker cannot overwrite a newer worker; a ready PDF cannot be updated or deleted.

PDFKit creates PDFs from immutable, minimized JSON snapshots; bundled OFL-licensed Noto Sans and Bengali fonts avoid dependency on a Windows-only font installation. PDF and snapshot SHA-256 values are retained. Snapshot reference appears inside the document; the PDF hash is available in document metadata responses and download headers. User-facing document timestamps use Asia/Dhaka.

PDF bytes remain private in PostgreSQL, without public storage URLs or a dependency on external object-storage upload availability. Download checks authorization before fetching bytes, uses `private, no-store`, and returns 202 with retry guidance while a PDF is being prepared. This is suitable for an MVP; large-scale archival storage and backup operations require production planning.

No AI provider receives contract identities or documents in this extension. Enforcement, arithmetic, numbering, classification and authorization are deterministic PostgreSQL/TypeScript operations. Existing independent AI features are untouched.

## D. Files modified

| Files | Purpose |
| --- | --- |
| `db/migrations/018_rental_protection.sql` | Policy baseline, renewal/lifecycle guards, immutable terms/documents/audit, legal-purpose DMP state, continuing-root billing uniqueness and notifications. |
| `db/migrations/019_rental_payment_events.sql` | Installment confirmation, acknowledgments, reversal, advance-credit allocation, invoice retention, income compatibility view and restricted privileges. |
| `server/src/schemas/contract.schema.ts`, `rental.schema.ts` | Strict amounts/dates, zero deposits, advance and revision/DMP input validation. |
| `server/src/services/contract.service.ts`, `payment.service.ts` | Transactional proposal/acceptance, continuing rental reads and existing-route payment integration. |
| `server/src/services/rentalManagement.service.ts`, `rentalRules.ts` | Scoped management, notifications, source provenance, DMP tracking, corrections and dual-party closure. |
| `server/src/services/rentalDocuments.service.ts` | Snapshot PDF renderer, hashes, private durable document worker and lease fencing. |
| `server/src/routes/rental.route.ts`, `controllers/payment.controller.ts` | Authorized new endpoints and partial-cash request integration. |
| `server/src/services/income.service.ts` | Include actual installments, exclude reversed/double-counted credit, stable event pagination and continuing-root active count. |
| `server/src/cron/jobs.ts`, `index.ts`, `utils/asyncHandler.ts` | Remove expiry-based vacancy, bill/catch up, start worker, mount routes, return controlled policy errors and avoid raw private error logging. |
| `server/assets/fonts/*`, `server/package.json`, `server/package-lock.json` | Portable licensed document fonts and PDFKit/types dependency. |
| `client/src/api/rentals.ts`, `styles/rental-management.css` | Authorized downloads, BDT/Dhaka presentation and responsive accessible management styles. |
| `client/src/pages/MyTenantsPage.tsx`, `components/RentalManagementPanel.tsx` | Tenant list, agreements, revisions, payments, receipts, notifications, DMP and closure controls. |
| `client/src/App.tsx`, `components/ProfileMenu.tsx` | Dashboard navigation and protected My Tenants route. |
| `client/src/pages/ContractFormPage.tsx`, `ContractDetailPage.tsx`, `OwnerIncomePage.tsx` | Zero deposit/advance explanation, continuing renewal proposal, effective rent, management integration and distinct installment row keys. |
| `server/src/services/rental*.test.ts`, `testing/rentalFixtures.ts`, `client/tests/rentalManagement.test.tsx` | Isolated synthetic policy, migration, ledger, security, HTTP/PDF and UI regressions. |
| `docs/superpowers/plans/2026-11-03-rental-protection.md`, this report, README | Audit, execution plan, operational boundaries and repeatable demonstration. |

Pre-existing dirty search/area files, client package manifests, graph outputs and other developers’ work were not included in this task’s commits.

## E. Verification

Executed commands:

```powershell
cd C:\Users\Abid\Desktop\nibash\server
npm test
npm run build
cd ..\client
npm test
npm run build
npm run lint
```

Final recorded backend run: **145 passed, 0 failed**. Frontend: **19 passed, 0 failed**. Backend TypeScript build and frontend TypeScript/Vite build passed. Client lint exited 0 with three warnings in existing AuthContext, MyListings and concurrently modified ListingDetail code. Vite reports its existing large-main-chunk warning.

The new tests execute actual PostgreSQL migrations, numeric calculations, triggers, constraints and stored functions in PGlite. Fresh installation executes all 19 migrations. Upgrade fixtures retain an old signed contract/deposit before 018/019. Browser-role tests reproduce permissive Supabase default grants before asserting restrictions. HTTP tests use actual Express routes, signed synthetic JWTs, services and actual PDF rendering/downloads.

Coverage includes anniversary/leap-year boundaries, decreases, renewal continuity, future and midmonth renewal billing, exact revised rent, untouched old invoices, ownership change, zero/excess deposits, forbidden extra fee fields, partial/multiple receipts, duplicate confirmations, reversal, advance credit/re-credit, pending-claim handling, historical retention, authorization, DMP status restrictions, tenant corrections and owner-first/tenant-first closure/new baseline.

Limits: PGlite supplies one embedded database connection; pool connectivity is adapted to it in the HTTP suite. Row-lock interleavings were reviewed, but independent PostgreSQL connection stress, networked Supabase behavior, actual process-kill persistence and production migration execution were not tested. Worker recovery is exercised with a failed renderer and an expired abandoned lease, not an actual OS restart. Existing legacy `__tests__` suites are excluded by the repository’s established test runner because they write to `DATABASE_URL`. Frontend tests use JSDOM, not full device/layout testing. No external payment provider, police or AI service was contacted by the new feature tests.

The generated one-page synthetic agreement and acknowledgment were rendered with Poppler and visually checked. PDF SHA-256 download headers were verified against actual bytes. These files can be regenerated under `output/pdf/` using the demo below.

Samples: [synthetic accepted agreement](../output/pdf/synthetic-agreement.pdf) and [synthetic payment acknowledgment](../output/pdf/synthetic-acknowledgment.pdf).

`npm audit` also reported five server dependency advisories: one moderate, three high and one critical, affecting existing direct/transitive packages (body-parser, multer, proxy-addr, qs and zod), rather than PDFKit. No broad dependency auto-upgrade was attempted; assess these before production deployment.

## F. Security review

Financial files are private database records with authenticated delivery. Party/ownership checks run server-side and browser database roles cannot invoke privileged functions. API responses use explicit fields; ordinary lists never include full identity numbers. Documents contain party names and agreed property/financial terms, without NID images or numbers. DMP data remains logically separate and sensitive collection/export stays disabled.

Confirmation requires authenticated landlord attribution and captures a permanent audit event. It does not establish bank settlement. Reversals retain original evidence. PostgreSQL numeric performs all monetary comparisons and balances. Snapshot and PDF hashes detect changed bytes but are not cryptographic signatures or external notarization. Generic server errors omit SQL detail and personal input.

The MVP prevents routine deletion of financial/document/contract history. Production retention duration, lawful deletion procedure, backups, encryption and privileged-access audit operations still require policy and deployment review; permanent retention must not be inferred to resolve every privacy obligation.

## G. Legal boundaries and provenance

The two-year freeze is explicitly **Nibash contractual/platform policy**, not a universal nationwide statutory prohibition. The [Premises Rent Control Act 1991](https://bdlaws.minlaw.gov.bd/act-print-748.html) is recorded for Sections 10, 13, 15–16 and 18; Controller redetermination is distinguished from platform enforcement. Ordinary deposits and excess advances are blocked conservatively; unsupported exceptions cannot be self-approved.

The [official DNCC policy listing](https://dncc.gov.bd/pages/policies) publishes January 21, 2026 guidance. Its attachment and subsequent clarification could not be fully verified during this work. The registry marks that uncertainty; DNCC guidance supplies no nationwide June–July enforcement rule here.

[Transfer of Property Act Section 107](https://bdlaws.minlaw.gov.bd/act-print-48/section-print-16322.html) addresses registered instruments for relevant longer leases. PDFs and account acceptance do not establish registration or recognized digital signature compliance. Statutory receipt form/signature compliance remains unverified, so payment PDFs are electronic acknowledgments.

The [official DMP tenant form page](https://dmp.gov.bd/important-forms/tenant-registration-form/) was located; CIMS retrieval was unreliable. Additional form requirements were not guessed. “Submitted manually — unverified” is a landlord’s report, not police acknowledgment. No CIMS API, government approval or legal certification is claimed.

## H. Repeatable synthetic demonstration

The fastest safe demo runs the real HTTP flow against an isolated database, without touching the configured database:

```powershell
cd C:\Users\Abid\Desktop\nibash\server
$env:NIBASH_DEMO_OUTPUT='C:/Users/Abid/Desktop/nibash/output/pdf'
node --import tsx --test src/services/rentalHttp.integration.test.ts
```

It creates synthetic owner 1, tenant 2, unrelated owner 3, properties and an application. It proposes BDT 20,000 rent effective November 15, 2026 with a permitted BDT 20,000 advance; rejects deposits, excess advance and hidden extra fee fields; records tenant acceptance and the November 15, 2028 increase eligibility; rejects the early BDT 21,000 increase; records a BDT 5,000 advance installment; confirms that specific cash event; checks duplicate/retry safety; renders both documents after simulating a rendering failure/lost lease; downloads as each party and denies the unrelated owner; opens scoped tenant records; records self-reported manual DMP tracking and a correction request; and exercises dual-party closure followed by a genuinely new rental baseline.

For the browser walkthrough on a reviewed **local development database**:

1. Apply 018 then 019 using your existing migration process after backup; do not run old destructive scripts or production commands from this guide.
2. Use synthetic registered owner/tenant accounts, a listing and a pending application. Owner proposes the agreement using the existing application flow.
3. Tenant opens My Contract or the contract link, reviews DRAFT and terms, then chooses **Accept agreement terms**.
4. In **Protection, documents & payments**, review initial rent, tenancy start and eligibility. Owner submits an early increase in **Agreements**; observe the explicit policy error.
5. The normal form shows deposit zero and the advance limit. The backend HTTP demo above independently demonstrates rejection when those limits are bypassed in a request.
6. Tenant opens **Payments**, enters the actual cash installment and records it. No paid acknowledgment exists yet.
7. Owner chooses **Confirm amount received** on that specific pending installment, with explicit issuer-attribution confirmation.
8. Refresh after the worker runs, then download the installment acknowledgment. Confirm amount received and the remaining invoice balance.
9. Each party downloads the accepted agreement under **Agreements**. The earlier DRAFT remains available; accepted rent amendments add versions without rewriting it.
10. Owner opens **My Tenants** through the profile menu and filters current/upcoming/former relationships. The unrelated owner’s view contains no such relationship.
11. Open **DMP preparation**, consult the official link and save a preparation status. The UI explicitly says that nothing is submitted through this feature; any manual submission remains unverified.

Run backend and client with their existing `npm run dev` commands. New document processing starts with the backend. These steps assume migrations and synthetic local accounts; no production data was seeded by this task.

## I. Remaining production blockers

- Review statutory receipt form/signatures, lease execution/registration, geographical applicability and DNCC clarification with qualified counsel.
- Resolve the dependency audit advisories; perform multi-connection PostgreSQL concurrency/load tests and a backup/restore exercise.
- Rehearse migrations against a sanitized production-shaped clone; coordinate application rollout, trusted DB-role privileges and worker monitoring. The configured database has not been migrated.
- Define retention/deletion, privileged access review, backup encryption and incident procedures for the private financial archive.
- Establish a controlled historical-tenancy verification/import workflow. Existing uncertain records intentionally remain verification-needed.
- Test mobile browsers, keyboard/screen-reader flows and longer Bengali names/addresses; samples inspected here use synthetic English names. PDFs are not tagged PDF/UA or certified archival documents.
- Confirm real postal/unit-address completeness. Resolve pending proposal cancellation and broader non-rent amendment requirements before expanding beyond the supported workflow.
- Any future DMP export or CIMS connection needs independently established requirements, authorization, safeguards and an approved interface.

## J. Hackathon readiness

The core protected agreement → confirmed installment → downloadable records → authorized tenant management flow is demonstrable with synthetic data. Financial enforcement and accounting run without AI or third-party availability. Regression, migration, private-download and PDF-recovery evidence supports an MVP demonstration; it does not certify production operations or legal compliance.

Privacy is conservative: no new identity-document collection, no police integration and no sensitive agreement content sent to AI. UX provides existing-dashboard navigation, responsive tenant records, distinct advance/deposit explanations, explicit confirmation and recoverable errors. The remaining deadline work should emphasize a local rehearsal and account preparation, rather than adding an ambitious AI legal assistant.

### Modern Web Guidance

- **`responsive-table`**: I used a focusable named scroll region and container-based stacked rows with per-cell labels, following “Give the wrapper a `role="region"` attribute” and preserving readable relationships on narrow layouts.
- **`forms`**: I associated visible labels/help text with controls and used live errors and at least 48px targets, following “always associate `<label>` with its input” and “use `aria-live` for dynamic error announcements.” Server rules remain authoritative.
