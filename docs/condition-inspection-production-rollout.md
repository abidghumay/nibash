# Phase 2 production rollout

Released November 5, 2026, Bangladesh time, following the owner's explicit “push deploy” instruction.

Application commit: [ba002e9f1a6340ca07238c6d486a577ce428d014](https://github.com/abidghumay/nibash/commit/ba002e9f1a6340ca07238c6d486a577ce428d014).

Frontend: [Nibash](https://nibash-one.vercel.app/). API: [health](https://nibash-api.onrender.com/health).

## Source and validation

Committed and pushed the 59 Phase 2 application, migration, test, documentation and synthetic-evidence files to `main` without a force push. The `.gitignore` commit includes only the inspection-demo data exclusion; unrelated Playwright additions remain local. Client package/lock changes, Graphify, skills, media and scratch work were excluded.

Fresh release checks passed: 202 server tests, 32 client tests, server TypeScript build and client production build. The existing large client-bundle warning remains. The staged-source check found no configured database/JWT/Gemini/Supabase secrets. Whitespace validation passed.

## Backup and migrations

A fresh private backup and operation records are retained outside Git at `C:/Users/Abid/.codex/backups/nibash-condition-phase-two-20261105`.

- Backup: 561,490 bytes, 882 archive entries; archive listing and full SQL decode validated.
- Backup SHA-256: `ec5f0884cc40604e3277ab0dbaa693e69099e248707be26e0b413c9451442b5b`.
- Restored the public schema/data into a fresh loopback PostgreSQL 17 instance and rehearsed the migrations; the rehearsal process was stopped afterward. This was not a full Supabase infrastructure restore.
- Applied only additive migrations 022 and 023, together in a guarded transaction with lock/statement timeouts. Bootstrap migrations were not replayed.
- `022_move_out_inspections.sql` SHA-256: `b279686d78f83953875bf158cf69118625b7367d6443b4b02a62d1b219b09ab4`.
- `023_condition_analysis_jobs.sql` SHA-256: `278f95d64907cac36b6c347bb688ac0b3ba4c329cc99b40aa5896b0497fa9007`.
- Before/after row counts and whole-row fingerprints remained identical for users, listings, contracts, payments, documents and all four Phase 1 condition tables. The checked originals were briefly share-locked during the migration transaction.
- All five new tables have RLS enabled and no inspected PUBLIC/anon/authenticated table grants.

No synthetic tenancy, inspection, payment or financial event was inserted into production for release verification.

## Hosted private storage check

Uploaded one project-generated 128×128 PNG, with no home, identity or personal content. The new server-side private download returned exactly the original bytes. A 120-second signed download returned HTTP 200 and matching bytes; the public object URL returned HTTP 400. Removed the exact probe afterward. No existing evidence was modified or deleted; the final check found zero condition-storage objects.

## Live deployment evidence

Verification at the release check:

- GitHub reported Vercel success for application commit `ba002e9`.
- The production frontend and deployed JavaScript returned HTTP 200. The bundle contains the move-out inspection route, landlord approval UI, identity-document attestation and correct production API origin.
- Render health returned HTTP 200 with database access.
- Move-out inspection GET: existing authorized owner 200, tenant 200, unrelated account 403, anonymous 401.
- Cross-party photo URL request returned 403; an authorized nonexistent image returned 404.
- Private inspection responses carry `Cache-Control: private, no-store`.
- No baseline/inspection was synthesized: inspection reads returned null, with zero persisted move-out inspections and analysis jobs.
- Baseline report, rental details, payments, notifications, My Tenants and sandbox configuration reads all returned HTTP 200.
- The existing payment sandbox remains disabled.
- Baseline and move-out real-home AI processing both report disabled. No production secrets or provider-processing flags were changed.

Short-lived diagnostic JWTs were used only in memory; tokens and private response bodies were not logged. Render dashboard commit metadata/build logs were not inspected; the newly mounted authenticated endpoint behavior confirms the Phase 2 API is serving. This read-only smoke is not a full production inspection-write demonstration. The actual end-to-end write/review/approval demonstration used the isolated synthetic setup described in the implementation report.

Sanitized machine-readable evidence: `output/condition-phase-two/production-release.json`. Private backup, migration and detailed operation records remain outside Git.

## Remaining boundaries

Real-home Gemini processing stays behind the existing operator gate and both parties' exact-snapshot permissions. Paid provider processing, disclosure and no-training safeguards must be reviewed before enabling it. There is no automatic identity-document detector/redactor. Retention/deletion/reconciliation jobs, backup expiry and a bounded dispute-escalation policy remain outstanding, as documented in [the implementation report](condition-inspection-phase-two.md).

The release does not enable bounding boxes, infer liability, calculate charges, mark rent paid or automatically release a listing on AI completion or expiry. Human condition acceptance plus independent tenant vacancy control final closure.
