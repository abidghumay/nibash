# Document verification rollout — 1 November 2026

This log records actions actually performed under the owner's deployment authorization.
The source-level explanation, alternatives, and changed-line map are in
[document-verification-fixes.md](document-verification-fixes.md).

## Completed

1. Inspected the configured Supabase database and storage without printing credentials.
   Found 34 documents, 34 referenced attachments, no duplicate listing/type pairs,
   and 37 objects under the public `listing-images/documents/` prefix.
2. Created a full PostgreSQL custom-format backup using PostgreSQL 17.11 tools.
   Backup directory: `C:/Users/Abid/.codex/backups/nibash-document-rollout-20261101`.
   `database.dump`: 391,053 bytes, 602 archive entries, SHA-256
   `2299be0582f209b79020cd00c8860902652a40243f828960489160336e51dc4b`.
   Validated its listing and fully decoded the archive into `restore-validation.sql`.
   This validates readability; a restore into a separate database has not been tested.
3. Saved database/storage metadata snapshots and downloaded all 37 public document
   objects (4,595,874 bytes), recording SHA-256 hashes in `document-file-manifest.json`.
   These private backups remain outside the repository and are not committed.
4. Applied `db/migrations/015_secure_document_lifecycle.sql` transactionally.
   The database now has versioned reviews, durable AI jobs, and cleanup records.
   All 34 documents remain; none had an existing verified approval to archive.
   Legacy screening is flagged for resubmission; no legacy files were sent to Gemini.
5. Created `verification-documents` through the Supabase Storage API as a private
   bucket, with a 5 MB limit and JPEG/PNG/WebP/PDF MIME types. Applied the restrictive
   anonymous/authenticated policy from `db/supabase_document_storage.sql`.
6. Reinstalled locked dependencies with `npm ci` in both projects. All 57 backend
   tests pass, backend TypeScript build passes, and client TypeScript/Vite build
   passes. A bcrypt hash/compare smoke check also passes. Vite reports its existing
   large-bundle warning; no build failure occurred.
7. Confirmed GitHub access through the existing credential manager and identified
   `main` as the production branch used by Vercel. Hosting URLs supplied by owner:
   frontend `https://nibash-one.vercel.app/`, backend `https://nibash-api.onrender.com`.
8. Committed the source fixes as `05cbb22` and pushed them to production `main`
   with a normal fast-forward from `1d876fb`. Unrelated untracked artifacts were
   excluded. Vercel reported success; its production bundle contains the new
   screening text and uses `https://nibash-api.onrender.com/api`.
9. Ran the compiled private-copy migration. The initial run migrated 23 attachments
   before a storage operation failed; the safe rerun migrated the remaining 11.
   Each copy was downloaded and compared byte-for-byte before changing its pointer.
   The script's generic failure message did not identify that storage operation.
10. Found two additional unlinked media records under the old document prefix.
    Confirmed neither was linked to a listing photo or review. Copied both files
    privately, verified their bytes, and preserved their media rows. Removed the
    backed-up public objects, including the folder placeholder. Public apartment
    photos remain in `listing-images`; that bucket remains public by design.
11. Drained the cleanup queue, including an abandoned migration-copy reservation.
    The final database check shows **34 documents, 34 attachments, zero legacy
    attachments, zero cleanup jobs, and zero public document objects**.
12. Confirmed the Render backend runs the new behavior: owner and verifier requests
    return 200 with versioned documents, signed private URLs, `Cache-Control:
    no-store`, and no AI score field. Anonymous access returns 401; an unrelated
    authenticated user receives 403. `/health` returns 200 with database access.
    These read-only checks used short-lived diagnostic tokens signed locally;
    tokens and document contents were not printed or committed.
13. Checked every original public URL: **37/37 denied access** from this machine.
    During the synthetic test, all 35 referenced private objects denied direct
    public access and permitted authenticated backend download; a signed download
    returned 200. A separately generated one-second signed link returned 400 after
    expiry. Application links retain their configured 300-second lifetime.
14. Created one temporary, unavailable listing for an end-to-end synthetic check.
    The live API rejected two PDF files with 400 and accepted one two-page PDF with
    201, upload version 1, private storage, and `application/pdf`. The Render worker
    claimed the job, retried three times, and reached `failed` rather than leaving
    it pending indefinitely. Removed this exact fixture, its document/job/media,
    and its storage object afterward. No existing listing was replaced or reviewed.
15. Verified the configured local Gemini key can read the `gemini-3.8-flash` model
    metadata and that the model advertises `generateContent`. Actual generation
    did not complete: the synthetic PDF timed out at the application's 15-second
    deadline and at a diagnostic 90-second deadline. A minimal text-only generation
    probe also timed out after 30 seconds. No speculative timeout or model change
    was deployed based on these results.

## Environment

The local backend already has `DATABASE_URL`, `JWT_SECRET`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, and `PORT`. No new mandatory variable
is introduced. Optional `GEMINI_MODEL` now defaults in code to `gemini-3.5-flash-lite`.
The deployed frontend's `VITE_API_URL` was verified through its bundle to target
`https://nibash-api.onrender.com/api`. No local or hosted environment variables
were changed. Render's database, authentication, and Supabase credentials work
for the tested paths. Its Gemini settings have not been inspected directly.

## Remaining issue: Gemini generation

Follow-up on 1 November: `gemini-3.8-flash` again timed out on a small request,
while `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` both answered minimal
requests. The real screening function returned an assessment for a synthetic
two-page PDF with `gemini-3.5-flash-lite` in 7.4 seconds. The application default
was changed to that model; `GEMINI_MODEL` still overrides the default. A regression
test verifies the default and override. Backend tests: 58 passed; build passed.
This proves neither model accuracy nor production behavior until a new deployed
worker test succeeds. Render environment settings are still inaccessible.

Live follow-up: a new synthetic upload returned 201 and the multi-file check
returned 400, but its screening job failed twice and was queued for retry. This
does not identify the error or prove which model the deployed service used. The
exact test listing, document, job, media row, and object were removed afterward;
the database again has 34 documents, 34 attachments, zero public document objects,
and no remaining cleanup jobs. Vercel reported a successful deployment of commit
`cc3db0c`; Render's deployed commit and Gemini environment override could not be
independently inspected without service access. AI screening remains unresolved.

Follow-up changes: `server/src/services/aiDocumentVerifier.service.ts:213`
selects the new default, `server/.env.example:7` shows it, and
`server/src/services/aiDocumentVerifier.service.test.ts:8` checks both the default
and explicit override. The Lite model answered the synthetic request faster in
these observations, but this is not a benchmark or proof of equivalent accuracy.

The code release, schema migration, private-file migration, public-copy cleanup,
and access checks are complete. **Successful AI screening is not verified.**
The production synthetic job exhausted its retries; local generation probes also
timed out. This does not establish whether Render's failure has the same cause.
Render logs/environment access is needed to distinguish a missing or different
production key/model from provider/network/quota problems. A Render API key was
requested through local environment configuration, not through chat.

Once access is available: inspect the worker error/log and Gemini configuration,
verify the provider request from the deployed environment, correct the confirmed
cause, repeat the synthetic two-page test, and remove its exact fixture again.
Do not bulk requeue or resubmit real documents merely to test provider availability.
The current UI supports manual review with an explicit override and audit reason.

No forced Render interruption/restart test or labeled AI-accuracy evaluation was
performed. Recovery and stale-result handling passed the isolated database tests.
The old backend was not paused through Render's dashboard during release; it was
replaced by the Git-triggered deployment. The final inventory found no remaining
public document objects or legacy attachment pointers.

## Evidence files and commands

The owner supplied `nibash-api-deploy-cc3db0c-2026-11-01-2127.log` from Downloads.
It confirms checkout of `cc3db0c` on `main`, a successful TypeScript build, server
startup, and Render's live-service announcement. The final line is `Document
screening attempt failed: job 2`, without a cause. This establishes that Render
ran the model-default change; it does not establish which model an environment
override selected, or why the request failed. The dotenv `injected env (0)` line
only reports values loaded from a local file, not whether Render supplied secrets.

To make the next runtime log actionable, the worker now records the failing stage
and a fixed error category: missing Gemini key, HTTP status, timeout, network error,
invalid model response, or unknown. Arbitrary messages, response bodies, document
contents, URLs, and credentials are excluded. Changes are in
`server/src/services/documentAiJobs.service.ts:15` and its screening catch block;
the redaction regression is in `documentAiJobs.service.test.ts:5`. All 59 backend
tests and the backend build passed. No database or environment change is required.
The diagnostic patch was pushed as `0350884`. A synthetic upload at 21:33 Dhaka
was accepted and its job retried after failing; a fresh Render runtime log should
contain the new `stage=` and `reason=` fields if this commit had finished deploying.
The exact fixture and file were removed, and final checks again found 34 documents,
34 attachments, zero legacy/public document objects, and an empty cleanup queue.

The private backup directory contains the database dump, archive listing, metadata
snapshots, per-object hashes/bytes, migration results, storage verification results,
and `synthetic-smoke.json` with the fixture's lifecycle and failed-job result.
Operational scripts are copied there under `operations/` for auditability; they
read the local environment and do not embed credentials. Do not rerun the backup
or migration modes blindly: some intentionally refuse existing outputs.

Executed build/test commands: `npm ci` in `server/` and `client/`, `npm test` and
`npm run build` in `server/`, and `npm run build` in `client/`. The file-copy command
was `node dist/scripts/migratePrivateDocuments.js --apply` from `server/`.
Migration 015 was applied once through a PostgreSQL connection; earlier migrations
were not rerun against production. The FK/optional-cron changes apply to fresh setup.

## Recovery and limitations

Keep the backup directory private. Database backups and document bytes are sensitive.
If migration recovery is needed, first stop writes and restore into an isolated
database to inspect the result. Do not blindly restore over a live database.
Do not return documents to a public bucket as a routine rollback.

Earlier in the source-fix task, the legacy default test command used the configured
database and created test records. Its cleanup hooks ran, but complete removal was
not independently established. The replacement default test command isolates all
credentials and uses an embedded database. No ambiguous production records were deleted.

The browser smoke checks from the source-fix task used mocked APIs. They covered
replacement uploads, review override/version handling, and the stale-review race;
they were not production end-to-end tests. No measured AI accuracy claim is made.
