# Multilingual natural-language property search

Initial implementation verified on 2 November 2026 and deployed as bed38f2. A provider-schema correction was verified on 3 November 2026. No migration or production database write is required. Existing user changes in graphify/brag output were left untouched.

## Architecture and behavior

`POST /api/listings/search/interpret` accepts only `{ "query": "..." }` (1–600 trimmed characters). A separate Gemini adapter receives the search text and current database area/amenity catalog. It receives no request headers, authentication token, user record, document, listing-owner details or conversation history. Common credentials, email addresses and Bangladesh phone numbers (including Bangla/mixed digits) are removed from the text first. Avoid entering other personal details into a property query; pattern redaction is not a comprehensive PII classifier.

Generation uses schema-constrained JSON, then strict Zod validation, quoted-input evidence checks, numeric grounding, catalog validation and conservative comparison/policy checks. Only validated explicit values become filters. Aliases resolve only when the corresponding canonical record actually exists. For example, `lift`/`লিফট` resolve to Elevator; parking to Garage. “Internet Ready” does not imply an active internet subscription.

The response contains `status`, `filters`, `preferences`, `unsupported`, `warnings` and server-side `latencyMs`. Mandatory requirements are the default; explicit local optional language is necessary to make something a preference. Preferences are displayed separately and do not filter or rank results. Unsupported mandatory conditions block the frontend until the user explicitly removes them or returns to ordinary search.

The interpreter never generates SQL or searches listings. Existing `GET /api/listings/search` remains the execution endpoint, with additive `minRent`, `minBedrooms`, `pets`, `keywords` and `strict=1` parameters. Strict mode bypasses the legacy natural-language parser and uses the reviewed structured filters/keywords. Ordinary clients retain existing parsing and endpoint behavior. Blank/malformed new numeric parameters and unknown strict-mode keys are rejected, and conflicting numeric filters return HTTP 400.

Both existing SQL branches retain approved-only visibility, full-text/trigram matching, media attachment, cursor ordering and parameter binding. New minimum rent/bedroom and explicit true/false pet predicates are present in both branches. The existing parser and property card components were reused without replacing the search engine.

ListingsPage offers a separate natural-language mode. Interpretation occurs only on submit. Users can edit every supported filter, combine manual filters by intersection, review conflicts, and explicitly remove unsupported requirements. Pagination uses an immutable snapshot of the effective request; it does not call the model again. Stale interpretations/listing responses are discarded after edits.

## Verification results

| Check | Result |
| --- | --- |
| Safe server suite: `cd server; npm test` | **107 passed, 0 failed** after the provider-schema regression fixes |
| Frontend utility tests: `node server/node_modules/tsx/dist/cli.mjs --test client/tests/naturalLanguageSearch.test.ts` | **7 passed, 0 failed** |
| Server production build: `cd server; npm run build` | Passed |
| Client production build: `cd client; npm run build` | Passed; existing large-chunk warning (~674 KB JS before gzip) |
| Client lint: `cd client; npm run lint` | Exit 0; four existing warnings in unrelated files, none in added feature files |
| `git diff --check` | Passed |

The new backend coverage comprises 23 unit tests plus 17 nested integration cases (41 tests including the integration parent). Integration tests execute real PostgreSQL SQL in isolated PGlite with pg_trgm and the project's migrations/seed catalogs. The default test runner excludes the legacy suites that write to DATABASE_URL and supplies an unreachable test-only DATABASE_URL.

Coverage includes English/Bangla/Banglish equivalents; Bangla numerals; k/hajar/thousand/lakh/BDT; exact/minimum bedrooms; two-sided rent; aliases/typos; valid/unavailable amenities; transit proximity; preferences/mandatory conditions; hallucinated prices/evidence; reversed comparisons/pet policy; amenity exclusions; manual conflicts; empty matches; malformed/truncated/provider-error responses; hung provider/catalog deadlines; input limits; rate limits; authorization; approved visibility; SQL binding; and cursor pagination. Hand-authored model-response fixtures test the validation contract, **not model accuracy**.

Browser QA used a temporary synthetic API backed by no database connection. It verified the narrow layout (607 px viewport), Bangla submission, editable controls, conflict blocking, mandatory transit blocking, explicit removal restoring cards, and ordinary/natural mode switching. The isolated real-SQL tests separately verify result filtering. Screenshot: [search preview](natural-language-search-preview.png).

## Live provider evaluation and latency

The checked-in `server/scripts/search-evaluation.json` contains 12 manually specified expected-filter cases. The live evaluator uses this synthetic catalog and never opens a database connection.

The initial provider request could time out or fail with HTTP 400. A controlled comparison on 3 November isolated the schema complexity issue: the constraints array's `maxItems: 32` combined with its field enum was rejected by Gemini. Removing the array bound from the provider schema produced successful constrained output; Zod still enforces the 32-item bound locally. Provider schema enums and strict object validation remain. The follow-up also handles Bengali locatives (`ধানমন্ডিতে`), equivalent Bangla/ASCII numeric evidence, and upper-bound range separators (`থেকে` / `theke`). The model catalog now sends canonical names without internal IDs, with explicit instructions for area names, parking/garage aliases and negative pet policies.

Final live evaluation of all **12 manually specified fixtures: 12/12 passed** against `gemini-3.5-flash-lite` with a 10-second timeout. This includes the equivalent English, Bangla and Banglish requests, two-sided rent ranges, floors, pet policies, aliases, unsupported transit/amenities and optional parking. Measured median latency was **1557 ms** and empirical p95 **9007 ms** (range **934–9007 ms**). See `server/scripts/search-evaluation-results.json` for each expected/actual result. This is a small synthetic fixture evaluation, not a general accuracy or production latency guarantee. Earlier failures are retained here as investigation history rather than described as successful requests.

Synthetic route integration requests in the final suite took about 15 ms for interpretation with a stubbed provider and 25–45 ms for rate-limited/disabled paths, excluding database fixture startup. These local in-process measurements do not predict network or production latency.

To repeat a live evaluation from `server` in PowerShell:

```powershell
$env:SEARCH_AI_ENABLED = 'true'
$env:SEARCH_AI_MODEL = 'gemini-3.5-flash-lite'
node --import tsx scripts/evaluate-search.cjs
```

The evaluator overwrites `scripts/search-evaluation-results.json`, reports mismatched expected/actual filters, and exits nonzero on failed cases. Choose an accessible supported model and working quota before interpreting its results.

## Deployment configuration

Set server-side variables from `server/.env.example`:

```dotenv
SEARCH_AI_ENABLED=true
SEARCH_AI_MODEL=gemini-3.5-flash-lite
SEARCH_AI_API_KEY=<server-only Gemini key>
SEARCH_AI_TIMEOUT_MS=5000
```

`SEARCH_AI_API_KEY` may be omitted to reuse `GEMINI_API_KEY`; the search model never falls back to `GEMINI_MODEL`. `SEARCH_AI_ENABLED` defaults off and an explicit search model is required. The timeout defaults to 5000 ms and is clamped to 100–10000 ms across catalog acquisition and generation. Interpretation has a separate limit of 10 requests/minute/IP and eight concurrent requests/process. Ordinary search keeps its existing 60/minute/IP limit. Preserve the application's trusted-proxy configuration and add shared edge limits when deploying multiple instances; the existing limiter is in memory per process.

Deploy the client and server changes together, retain existing database search migration 013/pg_trgm, configure outbound HTTPS to Gemini, and review the provider's terms/data handling and available model/quota. No vector database, new package or database migration is required. API keys belong only on the server. Leave AI disabled if provider availability cannot be verified; ordinary search stays available.

The adapter follows [Gemini structured-output guidance](https://ai.google.dev/gemini-api/docs/structured-output?lang=rest) and the [GenerationConfig reference](https://ai.google.dev/api/generate-content), while reusing the project's existing generateContent HTTP approach.

## Known limitations

- Live provider availability and latency vary. The 12-case fixture run passed with a 10-second timeout, including two requests above five seconds; production should use SEARCH_AI_TIMEOUT_MS=10000 when enabling search.
- Model omissions and unfamiliar language remain possible. Conservative evidence/alias/semantic guards can report a legitimate but unfamiliar expression as unverified; they are not a complete grammar or an accuracy guarantee.
- Transit/school distances, commute times, alternative locations, amenity exclusions, and other unmodeled conditions cannot be verified. Preferences are informational.
- Interpreted state is kept in the page session; reloading requires submitting again. Ordinary URL/manual filter behavior is retained.
- Existing mixed full-text/trigram ranking uses different scores and does not provide a unified cursor across both candidate sources. This existing behavior was retained. The real-SQL pagination regression checks cover the existing structured/popularity path.
- The legacy seed references amenities.icon_path, absent from the migrations. Integration fixtures omit only that presentation column when loading the seed; production schema/data were not changed.

## Files changed

Modified:

- `server/.env.example`
- `server/src/controllers/listing.controller.ts`
- `server/src/middleware/rateLimit.ts`
- `server/src/routes/listing.route.ts`
- `server/src/services/search/fuzzyMatchArea.ts`
- `server/src/services/search/searchListings.ts`
- `client/src/pages/ListingsPage.tsx`

Added:

- `server/src/services/search/interpretSearch.ts`
- `server/src/services/search/searchCatalog.ts`
- `server/src/services/search/constraintEvidence.ts`
- `server/src/services/search/interpretSearch.test.ts`
- `server/src/services/search/search.integration.test.ts`
- `server/scripts/evaluate-search.cjs`
- `server/scripts/search-evaluation.json`
- `server/scripts/search-evaluation-results.json`
- `client/src/components/NaturalLanguageSearch.tsx`
- `client/src/utils/naturalLanguageSearch.ts`
- `client/tests/naturalLanguageSearch.test.ts`
- `docs/superpowers/plans/2026-11-02-natural-language-search.md`
- `docs/natural-language-search-report.md`
- `docs/natural-language-search-preview.png`
