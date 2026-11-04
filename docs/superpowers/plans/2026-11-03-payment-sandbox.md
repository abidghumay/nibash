# Rent sandbox implementation plan

Goal: complete one shurjoPay hosted sandbox flow using existing obligations and ledger.
Spec: user attachment and docs/payment-sandbox-report.md, section D.
Architecture: Express adapter + durable attempts + atomic PostgreSQL event/document transaction; React status polling; existing private PDF worker.
Constraints: synthetic contracts only, default off, development/test only, fixed sandbox origins, no deployment, preserve records and cash.

- [x] Add failing exact-money/provider-validation and PostgreSQL confirmation tests.
- [x] Add migration 020: synthetic allowlist, attempt states, unique provider ID, confirmation function, TEST method constraints. Do not rewrite historical migrations.
- [x] Implement shurjoPay adapter with bounded network requests and fail-closed identity validation; initiation, authorized read/verification and untrusted callback wakeup routes; durable verification worker.
- [x] Add sandbox controls to existing rental panel and TEST PDF text. Keep existing cash controls and ledger views.
- [x] Add isolated synthetic demo runner and provider checkout test, including failure/replay/mismatch/recovery and authorization coverage.
- [x] Build both apps, run scoped regression tests, inspect demo UI/PDF, document observed external-provider results and untested cases.

Work on codex/rent-payment-sandbox in the current checkout; retain unrelated changes. Execute sequentially with test-first implementation and review. No production DB access or automatic commits/deployment.

Outcome: genuine shurjoPay token and checkout APIs exercised; hosted checkout blocked by browser security policy. Added clearly labeled durable simulation fallback and verified it end-to-end. See payment-sandbox-report.md for exact test limits.
