# Production rollout — 3 November 2026

Released under the owner's explicit authorization to push and deploy all completed application work.

The rental protection, installment accounting, private PDF records, My Tenants, public registration policy and database-backed area/search improvements were fast-forwarded from `codex/rental-protection` to production `main`. Application release commit: `1897f83`. Vercel reported success for that commit. Render serves the new authenticated rental routes, area catalog and conflicting-area validation. A follow-up commit records publication metadata and this rollout evidence.

Production frontend: https://nibash-one.vercel.app/ . API: https://nibash-api.onrender.com . The public policy is available at `/policies/rental-protection`; registration and footer links were verified in the production browser. Policy version 1.0 became effective on publication, 3 November 2026.

## Database backup, restore rehearsal and application

Created a fresh PostgreSQL custom-format backup outside the repository at `C:/Users/Abid/.codex/backups/nibash-rental-rollout-20261103/database.dump`. Size: 427,651 bytes, 652 archive entries. SHA-256: `9d6a33b2431b98c1b7ad7939585fc31ab37a8fba165b6175be4a5f201ae5406c`. Listed and fully decoded the archive successfully.

Restored the public application schema and data into a private local PostgreSQL 17.11 database with `pg_trgm` and the browser roles. Applied 018 then 019 successfully against that restored copy. The temporary PostgreSQL process was stopped after the rehearsal. This rehearsal did not restore Supabase-managed schemas, storage objects or cron infrastructure.

Applied only the two additive migrations to the live Supabase database at 05:30 UTC, 11:30 Bangladesh time:

- `018_rental_protection.sql`, SHA-256 `92082e47ee54ab1427e56c7965b3d9720f51af90e8751a26c742d3bdc7d6f850`.
- `019_rental_payment_events.sql`, SHA-256 `32193ac2a01e4e9cda415af5a9cc78ce72c07def6a5c1a40758d666bc1ff9478`.

Both migrations committed. Counts remained 15 users, 4 contracts, 12 payments, 34 verification documents and 40 listings. Whole-row user/document fingerprints, pre-existing payment fields and the checked core contract fields remained identical. Added defaults and payment-root backfills are intentional migration changes. No existing tenancy was retrospectively marked verified.

Live inspection confirmed row-level security on the new financial/document tables and no `anon`, `authenticated` or PUBLIC table grants on the inspected private tables. Private manifests, query results and operation scripts remain outside Git. Do not replay these operations or restore the backup over production blindly.

## Validation

- Full isolated backend suite: 145 passed; backend TypeScript build passed.
- Frontend suite: 21 passed; TypeScript/Vite build passed; lint exited successfully with three existing warnings.
- Compatible backend lockfile updates resolved the five previously reported advisories. `npm audit fix --ignore-scripts` reported zero vulnerabilities; no forced major upgrades were used. Updated versions include body-parser 2.4.0, multer 2.5.0, proxy-addr 2.0.8, qs 6.17.1 and zod 4.6.7.
- Review found that simultaneous `area` and `areaName` could silently discard a constraint. A regression test reproduced HTTP 200 for conflicting names; the fix now resolves both supplied names and rejects disagreement. Full backend tests passed afterward; production returns HTTP 400 for the conflicting request.
- Production policy rendered all 12 sections and legal-source links. Registration showed an unchecked policy acknowledgment and the working policy link.
- Frontend production bundle contains the policy, `/owner/tenants`, database area catalog and correct production API URL.
- API health: HTTP 200 with working database connection. Area catalog: HTTP 200, 13 areas.
- Anonymous rental access: HTTP 401. Short-lived diagnostic authentication for existing accounts verified rules, tenant list, rental details, payments and inbox reads: HTTP 200. An unrelated user received HTTP 403 for rental details. Diagnostic tokens and personal response contents were not logged or committed.
- Tenant records return `Cache-Control: private, no-store`. The policy source link is present in the live rules response.

## Operational boundaries

Production checks were read-only and created no synthetic financial history. New private PDF generation/recovery passed the isolated integration tests; no live financial event was invented to exercise the production worker. The production document queue was empty when inspected. No load or multi-instance concurrency benchmark was performed.

This release does not certify legal compliance, police registration, payment-provider settlement or statutory digital signatures. Broader privacy/retention procedures, legal review and controlled historical-tenancy verification remain operational work. Registration policy acknowledgment is currently a browser requirement; a policy version and acceptance timestamp are not persisted by the registration API.

Local graphify artifacts, video work, caches and scratch test output were kept out of the application release. No environment secret was changed or committed.
