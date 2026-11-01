# Document verification fixes — 1 November 2026

The six reported defects and the two related review/MIME issues are addressed in
source. Production migration 015 and the private bucket/access policy were applied
on 1 November 2026. See [the rollout log](deployment-completion-log.md) for the
current file-migration, deployment, verification, and remaining-work status.
The existing Graphify map helped trace relationships; because it predates HEAD,
the current source was used to confirm behavior. Review covered the schema,
backend routes/services/auth/media relationships, document consumers, listing
approval, search, dashboards, and affected frontend flows. This is not a claim
that every unrelated component has undergone a security audit.

## What changed and why this approach

| Issue | Implementation | Why choose it; tradeoff against alternatives |
| --- | --- | --- |
| Public documents | Dedicated private `verification-documents` bucket; owner/verifier authorization before signing; 300-second URLs; authenticated backend downloads; no-store API responses; visibility checked before uploads/signing. | Keeps existing public apartment photos working without rewriting shared media helpers. Compared with proxying every byte through Express, signed downloads reduce backend bandwidth. A signed URL is a bearer credential until expiry; visibility checks add network calls. |
| Broken fresh migration | `Starred_Listings.user_id` references `users(id)`. Migration 011 schedules cron only when the extension is installed. | Correcting the FK is smaller and safer than renaming the users primary key and every dependent query. Optional cron removes an unrelated fresh-install dependency; deployments without it must schedule overdue-payment maintenance separately. |
| Only first attachment analyzed | UI, API helper, Multer, and service accept exactly one file per document type. Multi-page submissions use one complete PDF; all bytes go to Gemini in one request. PDFs retain their MIME type and `document` classification. Edit mode supports replacement. | Avoids page-level API calls, combining partial results, ordering multiple images, and introducing PDF-rendering dependencies. This reduces orchestration overhead; no latency/cost benchmark was measured. Users must combine multiple scans themselves; maximum file size remains 5 MB. |
| Lost AI work | Upload and queued job commit together. PostgreSQL worker uses leases, `SKIP LOCKED`, three attempts, retry delays, terminal failure, and restart recovery. | Reuses the existing database instead of adding Redis and its deployment/monitoring burden. It is durable but needs a persistent worker. One job per tick prioritizes simplicity over throughput; API retries are at-least-once and can repeat a model request after a crash. |
| Stale attachments/results | Unique document/type constraint, serialized upload transaction, incrementing upload version, replacement media, reset current review, durable storage cleanup. Both success and failure updates check version and lease token. | One version comparison is clearer than inferring freshness from ordered media IDs. Storage uploads happen outside the upload transaction, avoiding network waits while holding listing locks. Cleanup uses an outbox because PostgreSQL cannot roll back Supabase; deletion is eventual, not instantaneous. |
| Misleading AI confidence | Missing owner/number/match evidence prevents a pass; property documents also require address evidence. Document type mismatch cannot pass. UI uses screening labels and removes model percentages and the queue's average score query. | Deterministic evidence checks add little computation and avoid presenting an uncalibrated number as authenticity. Removing the average also removes unnecessary aggregation. These changes do not make visual AI a legal verification service or establish its accuracy on forged documents. |
| Human review audit | Records verifier, time, upload version, reason, AI status at review, and explicit override when screening has not passed. Stale reviews return 409. New upload clears current approval but keeps review history. | A separate review table preserves decisions across replacements; a boolean alone cannot. It adds a small insert per review. Legacy approval metadata is archived before requiring fresh review. Listing/lease occupancy states are not reset by this migration. |
| Error handling and UI | Upload validation returns 400; provider response bodies and sensitive URLs stay out of errors; expired signed URLs refresh on viewer open; pending screening polls in place. | Reuses existing API and components. Background refresh keeps the review form mounted while the reviewer types. |

The Gemini REST architecture is retained; `GEMINI_MODEL` is configurable and
defaults to `gemini-3.8-flash`. The model key is sent in a header, not the URL.
The service sends authorized document contents to Gemini for screening; private
storage does not mean that no AI provider processes the contents.

## Verification performed

- `server: npm test`: **57 passed, 0 failed**. The runner supplies synthetic
  credentials and an invalid local network database address. PostgreSQL behavior
  is exercised inside PGlite; storage and Gemini are mocked.
- Fresh migrations **001–015** execute in order against an empty embedded
  PostgreSQL database with `pg_trgm` enabled and `pg_cron` absent.
- Integration checks cover owner/verifier access, exact-one-file enforcement,
  private URL creation, PDF metadata, replacement, versioned audit, explicit
  override, late success/failure, lease reclaim, retry, terminal failure, storage
  cleanup protection/retry, rollback recovery, and rerunnable legacy copying.
- Complete PDF byte forwarding is asserted. A simulated final-page mismatch is
  flagged. These are transport/decision tests, **not** proof that a live model
  detects every final-page contradiction or forgery.
- Server TypeScript build and client TypeScript/Vite production build pass.
- Client lint finishes with four existing warnings: LocationPicker effect
  dependencies, MyListingsPage unused catch parameter, AuthContext fast-refresh
  exports, and ListingDetailPage's unrelated application effect dependency.
  Vite still reports the existing large bundle warning (about 648 kB).
- Headless Chrome with all API traffic mocked checks required override,
  version-2 review submission, a draft pinned to version 3 being blocked when
  polling discovers version 4, explicit draft reset before reviewing version 4,
  removal of AI percentages, edit-mode document
  staging, replacement of the staged file, and no page runtime errors. A full
  mobile-layout assertion was excluded because blocking external icon fonts
  causes the existing navigation's icon text to overflow.
- Independent review identified the draft-version race above; it is fixed and
  covered by the browser check. The remaining independent review was interrupted
  by an agent usage limit; no complete independent sign-off is claimed.
- No live Gemini quality evaluation, real PostgreSQL multi-process stress test,
  or deployed anonymous-download denial test has been performed. These remain
  rollout checks, not guarantees from the local tests.

**Earlier test-run incident:** before the default runner was isolated, the
repository's legacy database suites ran against the configured `.env` database.
They reported passing and their cleanup hooks ran. Complete removal of their
synthetic records has not been verified; some legacy cleanup ignores errors.
The new default runner excludes those suites and overrides service credentials.
No live schema migration or storage mutation was performed for this fix.

## Deployment procedure

1. Back up the database and pause old document uploads/workers. Inspect existing
   duplicates before migration:

   ```sql
   SELECT listing_id, document_type, count(*)
   FROM documents GROUP BY listing_id, document_type HAVING count(*) > 1;
   ```

   Resolve any duplicates deliberately while preserving evidence. Migration 015
   fails atomically on duplicates; it does not silently choose or delete one.

2. For a database already migrated through 014, apply only
   `db/migrations/015_secure_document_lifecycle.sql` with stop-on-error enabled.
   Do not replay destructive bootstrap migrations on existing data. The migration
   archives old approval metadata, clears document approval, and flags legacy
   submissions for complete-file resubmission/human review.

3. In Supabase's SQL editor, apply `db/supabase_document_storage.sql`. It creates
   or configures the private bucket and a restrictive policy denying direct
   anonymous/authenticated access. Keep the service-role key on the backend.
   Read-only inspection during this task found `listing-images` **public**; the
   private bucket was unavailable. These settings need deployment work.

4. With the server environment configured, run from `server/`:

   ```powershell
   npx tsx src/scripts/migratePrivateDocuments.ts
   npx tsx src/scripts/migratePrivateDocuments.ts --apply
   ```

   The first command only counts referenced legacy attachments. The second
   copies each file to private storage, compares the downloaded bytes, swaps its
   database reference transactionally, and queues deletion of its public copy.
   It is safe to retry after configuration/storage errors. It does not re-screen
   legacy multi-file submissions or silently combine their pages.

5. Deploy frontend/backend together, with migration 015 already applied. Run
   Express as an always-on process; `app.listen` starts the document worker.
   Request-scoped/serverless execution alone is insufficient. For serverless
   hosting, put this worker in a persistent process or adapt the exported
   single-job functions to the platform's scheduled execution mechanism.

6. Let cleanup drain and inspect outstanding records:

   ```sql
   SELECT storage_bucket, count(*) FROM document_storage_cleanup GROUP BY storage_bucket;
   SELECT status, count(*) FROM document_ai_jobs GROUP BY status;
   SELECT count(*) FROM media m JOIN document_media dm ON dm.media_id=m.id
   WHERE m.storage_bucket='listing-images';
   ```

   Do not declare legacy exposure resolved until the public copies are gone.
   The copy script covers referenced attachments only. Separately inventory the
   old bucket's `documents/` prefix for unreferenced objects from previous failed
   uploads or deletions, preserve any needed evidence, and remove those copies.
   Verify previously known public URLs no longer return content, including any
   applicable CDN cache. Never purge the entire apartment-image bucket.

7. Use synthetic files to check deployed behavior: anonymous/private direct URL
   denied, unrelated user denied, owner/verifier signed access works, expiry
   works, multi-file request rejected, full PDF with final-page mismatch reviewed,
   and worker interruption/restart recovers. Evaluate fabricated, blurry,
   mismatched, unrelated, and valid synthetic examples against a labeled set
   before making accuracy claims.

## Design references

- Private access and signed downloads follow [Supabase's download guidance](https://supabase.com/docs/guides/storage/serving/downloads)
  and [bucket access model](https://supabase.com/docs/guides/storage/buckets/fundamentals).
- Queue claiming uses PostgreSQL's documented queue-consumer use of
  [`SKIP LOCKED`](https://www.postgresql.org/docs/18/sql-select.html).
- Complete inline PDF input follows [Gemini document processing](https://ai.google.dev/gemini-api/docs/document-processing);
  model configuration follows the [model catalog](https://ai.google.dev/gemini-api/docs/models).
- Form controls apply modern-web-guidance's rule, “use native constraints:
  required, minlength, maxlength, pattern”: labeled reason fields, required
  override, length limits, and keyboard-accessible upload activation.

## Exact changed-line map

The following appendix is generated from the final working-tree diff. Numbers
refer to the updated files; deletion-only entries point to the surviving line
at the removal site. New files list their full span. These are source changes,
not a claim that generated bundles, user artifacts, or unrelated files changed.

| File | Updated line ranges | Why |
| --- | --- | --- |
| `README.md` | [66](C:/Users/Abid/Desktop/nibash/README.md:66), [82](C:/Users/Abid/Desktop/nibash/README.md:82), [85–91](C:/Users/Abid/Desktop/nibash/README.md:85), [106](C:/Users/Abid/Desktop/nibash/README.md:106), [109](C:/Users/Abid/Desktop/nibash/README.md:109), [122–132](C:/Users/Abid/Desktop/nibash/README.md:122) | Correct setup instructions; document safe testing and deployment prerequisites. |
| `server/.env.example` | [7](C:/Users/Abid/Desktop/nibash/server/.env.example:7) | Expose the configurable Gemini model. |
| `server/package.json` | [10](C:/Users/Abid/Desktop/nibash/server/package.json:10), [27](C:/Users/Abid/Desktop/nibash/server/package.json:27) | Use isolated default tests; add embedded PostgreSQL for SQL regression checks. |
| `server/package-lock.json` | [23](C:/Users/Abid/Desktop/nibash/server/package-lock.json:23), [36–42](C:/Users/Abid/Desktop/nibash/server/package-lock.json:36) | Lock the embedded PostgreSQL development dependency reproducibly. |
| `db/migrations/002_buildings_and_listings.sql` | [96](C:/Users/Abid/Desktop/nibash/db/migrations/002_buildings_and_listings.sql:96) | Fix the users primary-key reference. |
| `db/migrations/011_payment_procedure.sql` | [13–14](C:/Users/Abid/Desktop/nibash/db/migrations/011_payment_procedure.sql:13), [57–64](C:/Users/Abid/Desktop/nibash/db/migrations/011_payment_procedure.sql:57) | Make pg_cron scheduling conditional so fresh setup works without it. |
| `db/migrations/015_secure_document_lifecycle.sql` | [1–70](C:/Users/Abid/Desktop/nibash/db/migrations/015_secure_document_lifecycle.sql:1) | Add private-media metadata, upload versions, unique document types, review audit, durable jobs, and cleanup; archive legacy reviews. |
| `db/supabase_document_storage.sql` | [1–14](C:/Users/Abid/Desktop/nibash/db/supabase_document_storage.sql:1) | Configure private bucket and restrictive direct-access policy. |
| `server/src/controllers/document.controller.ts` | [6–8](C:/Users/Abid/Desktop/nibash/server/src/controllers/document.controller.ts:6), [21](C:/Users/Abid/Desktop/nibash/server/src/controllers/document.controller.ts:21), [33](C:/Users/Abid/Desktop/nibash/server/src/controllers/document.controller.ts:33), [36](C:/Users/Abid/Desktop/nibash/server/src/controllers/document.controller.ts:36) | Return validation errors as 400, prevent signed-response caching, forward explicit review input. |
| `server/src/routes/document.route.ts` | [9](C:/Users/Abid/Desktop/nibash/server/src/routes/document.route.ts:9), [14–20](C:/Users/Abid/Desktop/nibash/server/src/routes/document.route.ts:14), [38](C:/Users/Abid/Desktop/nibash/server/src/routes/document.route.ts:38) | Enforce one file and translate multipart errors to a clear 400. |
| `server/src/schemas/document.schema.ts` | [19–24](C:/Users/Abid/Desktop/nibash/server/src/schemas/document.schema.ts:19) | Validate positive version, review reason length, and explicit override. |
| `server/src/index.ts` | [17](C:/Users/Abid/Desktop/nibash/server/src/index.ts:17), [58](C:/Users/Abid/Desktop/nibash/server/src/index.ts:58) | Start durable queue processing with the persistent server. |
| `server/src/services/document.service.ts` | [1](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:1), [4–5](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:4), [8](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:8), [28](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:28), [30–44](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:30), [48–75](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:48), [77](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:77), [81](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:81), [86–94](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:86), [97](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:97), [100](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:100), [103–124](C:/Users/Abid/Desktop/nibash/server/src/services/document.service.ts:103) | Authorize private access; transact replacement/versioning/job creation; reserve orphan cleanup; record versioned human reviews. |
| `server/src/services/documentStorage.service.ts` | [1–74](C:/Users/Abid/Desktop/nibash/server/src/services/documentStorage.service.ts:1) | Separate private storage, validate paths, check bucket privacy, sign short-lived URLs, and sanitize provider errors. |
| `server/src/services/documentAiJobs.service.ts` | [1–116](C:/Users/Abid/Desktop/nibash/server/src/services/documentAiJobs.service.ts:1) | Claim durable work with leases; guard both result paths; retry or fail; recover expired jobs and clean unattached objects. |
| `server/src/scripts/migratePrivateDocuments.ts` | [1–46](C:/Users/Abid/Desktop/nibash/server/src/scripts/migratePrivateDocuments.ts:1) | Provide dry-run and rerunnable byte-verified migration of referenced legacy attachments. |
| `server/src/services/aiDocumentVerifier.service.ts` | [6](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:6), [58](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:58), [69](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:69), [82–98](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:82), [104](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:104), [124](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:124), [161–162](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:161), [213](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:213), [216](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:216), [222](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:222), [240](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.ts:240) | Consume complete authorized bytes; require extracted evidence; flag type mismatches; clarify screening limitations; configurable model and safe errors. |
| `server/src/services/listing.service.ts` | [458](C:/Users/Abid/Desktop/nibash/server/src/services/listing.service.ts:458) | Remove misleading and unnecessary average AI confidence aggregation. |
| `client/src/api/uploadDocuments.ts` | [8](C:/Users/Abid/Desktop/nibash/client/src/api/uploadDocuments.ts:8) | Reject multiple files before making a request. |
| `client/src/utils/documentScreening.ts` | [1–9](C:/Users/Abid/Desktop/nibash/client/src/utils/documentScreening.ts:1) | Centralize non-authenticity screening labels and distinguish unavailable from pending. |
| `client/src/components/DocumentViewerModal.tsx` | [1](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:1), [18](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:18), [33](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:33), [139](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:139), [165](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:165), [276](C:/Users/Abid/Desktop/nibash/client/src/components/DocumentViewerModal.tsx:276) | Remove percentages, label human review, explain AI limitations. |
| `client/src/components/PropertyCard.tsx` | [206](C:/Users/Abid/Desktop/nibash/client/src/components/PropertyCard.tsx:206), [210](C:/Users/Abid/Desktop/nibash/client/src/components/PropertyCard.tsx:210) | Remove averaged AI percentage and clarify failed-screening badge. |
| `client/src/pages/ListingsPage.tsx` | [43](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingsPage.tsx:43) | Remove obsolete average score from the queue response type. |
| `client/src/pages/ListingFormPage.tsx` | [11](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:11), [103–106](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:103), [208–221](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:208), [376](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:376), [1053](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1053), [1067](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1067), [1116](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1116), [1132](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1132), [1139–1141](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1139), [1170](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1170), [1177](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1177), [1193](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingFormPage.tsx:1193) | One complete file/type; replace staged documents; support edit-mode uploads; accessible input; release preview URLs. |
| `client/src/pages/ListingDetailPage.tsx` | [1](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1), [29–32](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:29), [33](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:33), [252–254](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:252), [271](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:271), [762–771](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:762), [777–783](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:777), [1536](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1536), [1632](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1632), [1648](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1648), [1695–1696](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1695), [1751](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1751), [1771](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1771), [1796](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1796), [1811–1838](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1811), [1859–1871](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:1859), [2493](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:2493), [3172](C:/Users/Abid/Desktop/nibash/client/src/pages/ListingDetailPage.tsx:3172) | Version-aware review form/audit, explicit override, screening labels, in-place polling, signed-link refresh, and accessible errors. |
| `server/scripts/test-local.cjs` | [1–16](C:/Users/Abid/Desktop/nibash/server/scripts/test-local.cjs:1) | Exclude database-writing legacy suites and override real service/database credentials in default tests. |
| `server/src/services/documentLifecycle.integration.test.ts` | [1–192](C:/Users/Abid/Desktop/nibash/server/src/services/documentLifecycle.integration.test.ts:1) | Execute fresh SQL and lifecycle, stale-result, lease, cleanup, review, rollback, and legacy-copy regressions in PGlite. |
| `server/src/services/aiDocumentVerifier.service.test.ts` | [40](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.test.ts:40), [49–50](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.test.ts:49), [71](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.test.ts:71), [85](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.test.ts:85), [153](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.service.test.ts:153) | Update byte-input tests and evidence-dependent expectations. |
| `server/src/services/documentAiEvaluation.service.test.ts` | [3–16](C:/Users/Abid/Desktop/nibash/server/src/services/documentAiEvaluation.service.test.ts:3), [18–19](C:/Users/Abid/Desktop/nibash/server/src/services/documentAiEvaluation.service.test.ts:18), [21–27](C:/Users/Abid/Desktop/nibash/server/src/services/documentAiEvaluation.service.test.ts:21) | Cover required fields, document-type mismatch, malformed extraction, and later-page contradiction; durable behavior moved to SQL integration tests. |
| `server/src/services/documentAiFields.service.test.ts` | [65](C:/Users/Abid/Desktop/nibash/server/src/services/documentAiFields.service.test.ts:65) | Expect the authorized document API to omit model percentages. |
| `server/src/services/documentUploadAiTrigger.service.test.ts` | [3](C:/Users/Abid/Desktop/nibash/server/src/services/documentUploadAiTrigger.service.test.ts:3), [5](C:/Users/Abid/Desktop/nibash/server/src/services/documentUploadAiTrigger.service.test.ts:5), [7–14](C:/Users/Abid/Desktop/nibash/server/src/services/documentUploadAiTrigger.service.test.ts:7), [16–27](C:/Users/Abid/Desktop/nibash/server/src/services/documentUploadAiTrigger.service.test.ts:16), [28](C:/Users/Abid/Desktop/nibash/server/src/services/documentUploadAiTrigger.service.test.ts:28) | Replace microtask expectations with private-bucket, path, and error-redaction tests. |
| `server/src/services/listingAiQueue.service.test.ts` | [26](C:/Users/Abid/Desktop/nibash/server/src/services/listingAiQueue.service.test.ts:26), [46](C:/Users/Abid/Desktop/nibash/server/src/services/listingAiQueue.service.test.ts:46), [53](C:/Users/Abid/Desktop/nibash/server/src/services/listingAiQueue.service.test.ts:53) | Keep aggregate counts covered without average confidence. |
| `server/src/services/aiDocumentVerifier.bugHunt.test.ts` | [14](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:14), [46](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:46), [56](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:56), [114](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:114), [126](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:126), [219](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:219), [256](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:256), [295](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:295), [338](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:338), [347](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:347), [394](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:394), [422](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:422), [434](C:/Users/Abid/Desktop/nibash/server/src/services/aiDocumentVerifier.bugHunt.test.ts:434) | Adapt the pre-existing untracked bug-hunt tests to byte input and strict evidence; preserve original backup in the temporary directory. |
