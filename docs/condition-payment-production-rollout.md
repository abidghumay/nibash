# Condition report and payment sandbox production rollout

Released November 4, 2026 under the owner's explicit instruction to merge the isolated condition-report work with the current checkout and concurrent payment work, push and deploy.

Application commit: [32565597e754b04f5470583c5f1a922ff3df9074](https://github.com/abidghumay/nibash/commit/32565597e754b04f5470583c5f1a922ff3df9074).

Production frontend: [Nibash](https://nibash-one.vercel.app/).
Production API: [health](https://nibash-api.onrender.com/health).

## Integration

Applied the Phase 1-only patch to the current checkout, preserving the concurrent payment changes. The combined source was committed on `codex/rent-payment-sandbox`, fast-forwarded into `main`, and pushed normally to `origin/main`. No force push was used. Unrelated Graphify changes, caches, videos, scratch files and earlier audit output remain local and were excluded.

The condition report uses the existing root contracts and contract detail page. The merged payment feature remains the development/test-only sandbox described in [its report](payment-sandbox-report.md). It is disabled in production; no live gateway, landlord payout or simulated financial history was enabled.

## Backup, rehearsal and migrations

Created a fresh private PostgreSQL custom-format backup at:

`C:/Users/Abid/.codex/backups/nibash-condition-release-20261104/database.dump`

- Size: 503,356 bytes.
- Archive entries: 777.
- SHA-256: `320436e43bdddf71e222563b468d54ab7b7ef03b34ef26fb6a61fd01f9eb3627`.
- Archive listing and full decode passed.
- Restored the public schema/data into a separate local PostgreSQL 17 database and rehearsed migrations 020 and 021. This was not a full Supabase infrastructure/storage restore.
- Applied only additive `020_payment_sandbox.sql` and `021_condition_reports.sql` to production; bootstrap migrations were not replayed.
- Applied migration hashes: 020 `08a1942cb6f17135934c4a0ed5ac4ade4646e5bcab8322659e1e70e3c900a62b`; 021 `e08fa1e6538d76065cca0ded213ebd7fc8a50d0e5a781ca20ff84bc59b0f389c`.
- Checked business-record counts and whole-row fingerprints before and after migration. All checked rows remained identical: 15 users, 4 contracts, 12 payments, 34 verification documents and 40 listings.
- Configured the dedicated private `condition-evidence` bucket with the repeatable bucket SQL. JPEG/PNG only, 8 MiB limit; restrictive policies deny browser-role SELECT, INSERT, UPDATE and DELETE even alongside broad legacy policies.
- Verified RLS on condition and sandbox tables and no PUBLIC/anon/authenticated table grants.

Private snapshots, migration results, full database backup, restore logs, operation scripts and smoke results remain outside Git in the backup directory. Do not blindly rerun migration operations or restore the backup over production.

## Verification

Combined current-checkout results:

- 179 server tests passed; server TypeScript build passed.
- 31 client tests passed, including the concurrent payment-panel refresh test; client TypeScript/Vite build passed.
- Existing large-JavaScript-chunk build warning remains.
- Staged-source secret scan and whitespace check passed.
- Independent integration review found no must-fix startup/deployment conflict.

Five additional checks used separate connections to the restored local PostgreSQL 17 database, rather than the serialized PGlite adapter:

1. Simultaneous edits: exactly one expected-version mutation succeeded.
2. Simultaneous owner/tenant confirmations: one locked report with both confirmations.
3. Concurrent duplicate confirmations: no duplicate confirmations.
4. An edit waited on the physical-closure row lock, then rejected using fresh eligibility. An actual PostgreSQL lock wait was observed.
5. Confirmation racing a submitted-evidence edit could not silently lock changed evidence; the winning edit created a new draft and invalidated prior active confirmations.

The local PostgreSQL process was stopped after testing. Production received no synthetic tenancy, baseline, payment or financial event for these concurrency checks.

## Hosted storage smoke

Uploaded one project-generated synthetic PNG through the real condition storage adapter. A 120-second signed download returned HTTP 200 and exactly matched the uploaded bytes. The corresponding public URL returned HTTP 400. Removed the exact probe object afterward; production had zero condition objects and zero condition reports when the deployment check ran.

The probe did not contain a real room, person or document. No existing object was replaced or deleted. No home photographs were sent to Gemini.

## Deployment verification

At the successful deployment check:

- GitHub reported Vercel success for application commit `3256559`.
- The production frontend returned HTTP 200. Its deployed bundle contained the condition-report routes/UI, locked-snapshot text, payment sandbox code and the correct production API origin.
- Render health returned HTTP 200 with database access.
- Condition-report reads: authorized owner 200, tenant 200, unrelated account 403, anonymous 401.
- Private responses carried `Cache-Control: private, no-store`.
- Cross-party photo access returned 403.
- Missing baseline remained explicit (`report:null`), and `ai_analysis_enabled:false`.
- Payment sandbox config returned HTTP 200 with `enabled:false`.
- Existing rental details, payment history, inbox and My Tenants reads returned HTTP 200.
- Private tables had no inspected browser grants, and RLS was enabled.
- The public homepage rendered in the browser.

Read checks used short-lived diagnostic tokens; tokens and private response bodies were not logged or committed. Render dashboard build logs/commit metadata were not inspected; live authenticated route behavior verified that the new API was serving requests.

## Boundaries

The six actual synthetic Gemini comparisons and the description-only recommendation remain documented in [the Phase 1 report](condition-report-phase-one.md). Production AI stays disabled. No AI output changes approval, liability, settlement or listing availability.

Real-device mobile camera/gallery behavior, an authenticated browser walkthrough with a newly created production baseline, retention/deletion jobs and backup expiry remain operational follow-up work. The real storage probe and production authorization reads do not constitute a full production baseline-write workflow.

Existing contract acceptance, renewal, closure, receipts, rent policy, NLP search and areas were preserved. The application release does not implement Phase 2 move-out approval or relisting automation.

