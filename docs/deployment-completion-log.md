# Document verification rollout — 1 November 2026

This log records actions actually performed under the owner's deployment authorization.
The source-level explanation, alternatives, and changed-line map are in
[document-verification-fixes.md](document-verification-fixes.md).

## Completed so far

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

## Environment

The local backend already has `DATABASE_URL`, `JWT_SECRET`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, and `PORT`. No new mandatory variable
is introduced. Optional `GEMINI_MODEL` defaults in code to `gemini-3.8-flash`.
The frontend's production `VITE_API_URL` must target the Render API, not localhost.
Hosting environment settings have not yet been inspected directly.

## In progress

Private file copy, removal of backed-up public copies, production code release,
and production smoke checks are not yet recorded as complete. Do not interpret
successful local tests or schema setup as proof that the deployed services run
the new code. The old backend has not been paused through Render's dashboard.

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
