# Multilingual property search implementation plan

**Goal:** Interpret submitted English, Bangla and Banglish requests without replacing PostgreSQL search.

**Architecture:** A public, separately rate-limited POST interpretation endpoint reads the area/amenity catalog and calls a separately configured Gemini model. Schema-constrained output is validated with Zod and grounded against quoted input and real catalog values. It returns structured mandatory filters, separate preferences, unsupported requirements and timing. It never executes model SQL. Existing GET search gains additive validated filters and a strict mode that bypasses the legacy text parser.

**Constraints:** No migrations, production writes or deployment. Approved-listing visibility and existing clients remain intact. Unsupported mandatory requirements and manual conflicts block AI result presentation. Provider failures return an explicit ordinary-search option, never silent relaxation. No per-keystroke AI calls.

1. Write representative expected-filter fixtures and failing interpretation tests; implement number normalization, catalog resolution and provider validation.
2. Extend existing parameterized search in both full-text and trigram branches with minimum rent/bedrooms and explicit pet policy; retain legacy parsing by default.
3. Add input validation, separate interpretation rate limit, opt-in configuration, redaction and bounded provider timeout.
4. Extend ListingsPage with submit-only natural-language mode, editable filters, requirement/conflict feedback, and identical effective filters for pagination. Test intersection semantics independently.
5. Run isolated real-PostgreSQL integration tests using PGlite, full safe server tests, client tests, both production builds and targeted review. Document measurements, configuration and limitations. Do not represent mocked model tests as model accuracy.

**Verification:** `npm test` and `npm run build` in server; client search utility tests, `npm run build` and relevant lint. Tests must not use the configured production DATABASE_URL. Live provider evaluation is opt-in and reported separately.
