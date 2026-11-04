# Rent payment audit and sandbox integration

Audit date: 2026-11-03. Scope: source at the current checkout, migrations 001–019, before implementation. Existing unrelated working-tree files are retained. No production database was inspected or modified. Source migration order is not proof of deployment state.

## A. Existing architecture (audit completed before edits)

`db/migrations/004_payments_and_reviews.sql:13` creates invoice-like payments linked to contracts; method names Cash, bKash and SSLCommerz are labels, with unused provider-reference columns. `011_payment_procedure.sql:10` adds billing month uniqueness; `018_rental_protection.sql:54` adds tenancy-root/month uniqueness across renewals. Contract acceptance calls billing after commit (`server/src/services/contract.service.ts:140`). The latest generator (`018:340`) calculates rent plus recurring charges for the current Dhaka month, applies accepted revisions, and clamps due days to 28. It does not backfill prior missed months.

Tenant routes (`server/src/routes/payment.route.ts:8`) authenticate JWTs; services check tenant or listing owner. `payment.service.ts:6` reuses an existing obligation; client amounts cannot create invoices. `payByCash` at line 53 calls `claim_rental_payment` (`019:58`), which locks the root/invoice, validates positive exact decimal amounts against outstanding, checks tenant ownership, and permits one pending claim. Method labels do not execute transfers. The generic create endpoint generates a new request key on each invocation; the cash route supports explicit idempotency keys.

Landlord confirmation uses event IDs (`server/src/routes/rental.route.ts:182`) or the compatibility payment route (`payment.service.ts:127`). `confirm_rental_payment` (`019:82`) locks the root, invoice and event, validates owner, records a confirmed event, updates outstanding/status, creates one immutable acknowledgment snapshot and a tenant notification atomically. Unique document event/version keys (`018:84`) and confirmation retry handling prevent duplicate acknowledgments. Partial invoices remain pending/overdue. Rejected claims remain recorded. Reversals (`019:118`) append linked corrections; they are accounting corrections, not refunds. Confirmed events and issued invoices are immutable (`019:147`). Advance allocations avoid counting rent a second time.

`rental_received`, `rental_credited`, and `rental_outstanding` (`019:14–27`) use confirmed unreversed events and advance allocations. `rental_income_payments` (`019:171`) includes those events plus historical confirmed invoices without events. `server/src/services/income.service.ts:90,152,237,319` scopes all income queries by owner and reads that view. Amounts are PostgreSQL numeric in storage but converted to JavaScript numbers in income responses.

PDFs: `server/src/services/rentalDocuments.service.ts:44,238` renders PDFKit documents from immutable snapshots, stores private bytes and hashes in PostgreSQL, leases work with SKIP LOCKED, retries failures with backoff, and reclaims expired leases after restart. `server/src/index.ts:69` starts the worker. Download authorization happens before reading bytes (`server/src/routes/rental.route.ts:197`); owner, tenant or current listing owner may download. No public PDF URLs. Notifications use database triggers (`017_automated_inbox.sql:35`) and installment notifications (`019:111`); startup reminders recover missing reminders, not missing historical invoices. Daily jobs (`server/src/cron/jobs.ts:5,16`) run in-process, with no durable billing job queue.

React has overlapping payment surfaces: `client/src/pages/ContractDetailPage.tsx:289` groups invoice statuses; `client/src/components/RentalManagementPanel.tsx:360` exposes actual balances, installment claims, event confirmations, reversals and acknowledgment downloads. The latter explicitly describes transfer methods as declarations. Both cash paths remain operational.

Answers: there is no external verification or money custody/transfer in the audited implementation. Tenants can make false claims, but cannot confirm them through the checked routes. A landlord can acknowledge receipt without external evidence; it is explicitly an acknowledgment. No cross-landlord access was found in the inspected payment/income/download checks. This is source inspection, not a penetration-test guarantee. Failed provider attempts, expiry and pending verification do not yet exist as models.

## B. Findings

| Severity | Finding | Evidence / scope |
|---|---|---|
| High, confirmed | Remote PostgreSQL TLS certificate verification is disabled. | `server/src/db/pool.ts:13`; connection interception risk, separate deployment remediation required. |
| Medium, confirmed | Legacy `get_contract_total_paid` ignores partial events and can count advance-funded invoices as new receipts. | `005_triggers.sql:100`; no current TS caller found. Do not use as financial authority. |
| Medium, confirmed | Billing only generates the current month; downtime spanning a month can leave a missing obligation. | `018:340`, `cron/jobs.ts:16`; restart does not run billing catch-up. |
| Medium, confirmed | Full installment confirmation emits invoice and event notifications; invoice text says owner confirmation. | `017:56`, `019:111`; online confirmations must avoid this attribution. |
| Medium, confirmed | Legacy contract history excludes partial events until invoice is fully confirmed. | `ContractDetailPage.tsx:294`; detailed Rental management is the authoritative event history. Balance itself already uses outstanding. |
| Medium, potential | Income month boundaries mix host-local JavaScript, UTC timestamps and DB timezone. | `income.service.ts:7,115`; boundary reconciliation requires deployment timezone review. |
| Low, confirmed | Generic claim API lacks caller-supplied idempotency; method reference fields accepted by schema are unused. | `payment.schema.ts:11`, `payment.service.ts:24`. Pending-claim constraint blocks immediate duplicate amounts. |
| Low, potential | Monetary response conversion to floating-point can lose precision for very large totals. | `income.service.ts:141`; new verification must use exact decimal comparison. |

No critical defect established. Historical migrations 004 contain DROP statements: never replay old migrations on a populated database. Apply only the new migration through the normal migration process.

## C. Official gateway comparison

Checked 2026-11-03. Unknown means not established from the reviewed official pages; it does not mean unsupported. No registrations, merchant agreements, or production requests were submitted.

| Provider | Sandbox/access | Checkout, verification and callbacks | Node / refunds / costs | Marketplace limits |
|---|---|---|---|---|
| SSLCOMMERZ | Self-service sandbox registration; separate test store credentials. | Hosted session API, IPN, mandatory validation API; cards, mobile wallets, internet banking. | REST and linked libraries; refund API documented. Published setup BDT 25,500; standard 2.5%, AMEX 3.5%, subject to merchant terms. | Ordinary merchant acceptance does not establish multi-landlord collection, split settlement or payouts; seek written approval. |
| **shurjoPay** | Public shared sandbox credentials; authentication actually returned code 200 and store 1 in this session. No merchant application needed for that test. | Hosted checkout; token → secret-pay → verification. Browser return/cancel URLs documented. Separate IPN setup/signature details not established; durable polling can recover abandoned returns. Cards and mobile methods available through checkout. | Official Node plugin; direct fetch avoids extra logger/token-state dependencies. Refund/dispute process described; public refund API not established. Production rates by quotation. | Live onboarding requires business/KYC documents and business bank account. Settlement is to registered merchant per agreement, not automatically to each landlord. No split/submerchant API established. |
| bKash | Current overview explicitly says sandbox open to everyone before onboarding completion. Credential provisioning details not established here; do not infer merchant approval is required for sandbox. | Hosted tokenized checkout; Create, Execute and Query; callback alone is not final. Signed IPN requires support provisioning. Wallet payments. | REST from Node; full/partial refunds and payout product documented. Fees not verified. | Organization onboarding/KYC/agreement for live. Payout product existence does not authorize Nibash's marketplace flow; beneficiary/approval conditions need confirmation. |
| Nagad | No official public developer specification or usable sandbox credentials found in reviewed official pages. | Merchant service exists; initiation, verification, callbacks and hosted API details unverified. | SDK, refund API, fees and sandbox eligibility unverified. | Contact merchant team for gateway and marketplace terms; no inferred split/payout support. |
| aamarPay | Official docs publish shared test store/key. Not externally exercised in this session. | Hosted JSON initiation; success/fail POST and cancellation return; Search Transaction API and IPN documented. | REST from Node; refund API and current fees not verified. | Live credentials via support; marketplace permission, split/submerchant/payout arrangements unverified. |

Sources: [SSLCOMMERZ API](https://developer.sslcommerz.com/doc/v4/), [sandbox registration](https://developer.sslcommerz.com/registration/), [pricing](https://sslcommerz.com/pricing/); [shurjoPay integration and SDKs](https://shurjopay.com.bd/frontend-developers/integration-howto), [REST contract](https://shurjopay.com.bd/frontend-developers/direct-integration-with-api), [official Node source](https://github.com/shurjopay-plugins/sp-plugin-nodejs), [onboarding/settlement FAQ](https://www.shurjopay.com.bd/), [merchant terms](https://admin.shurjopayment.com/merchant-registration); [bKash product/access overview](https://developer.bka.sh/docs/product-overview), [tokenized flow](https://developer.bka.sh/docs/tokenized-without-agreement), [IPN](https://developer.bka.sh/page/instant-payment-notification); [Nagad contact](https://frontend.nagad.com.bd/en/contact/); [aamarPay initiation](https://aamarpay.readme.io/reference/initiate-payment-json), [verification](https://aamarpay.readme.io/reference/search-transaction), [IPN](https://aamarpay.readme.io/reference/instant-payment-notification).

## D. Decision and design

Choose shurjoPay for this demo: published legitimate shared access was confirmed reachable, hosted checkout is small in scope, and independent verification fits Express. SSLCOMMERZ is a strong alternative with a registration step; bKash offers a narrower wallet flow; aamarPay is another viable shared sandbox but integrating two providers would add no demo value. Documentation contains inconsistencies (token status 1000 in prose versus 200 in sample/live sandbox; expiry units differ); validate actual responses conservatively.

Persist an attempt before calling the provider. Bind it to an existing synthetic rent obligation, fixed server-computed remaining BDT amount, tenant, merchant reference, provider and unique provider order ID. Never re-initiate an uncertain checkout automatically. Return/IPN input is only a wake-up hint; obtain all confirmation evidence through authenticated provider verification. Verify order IDs, merchant reference, obligation binding, amount, currency and successful status, then atomically append an event, update the invoice, create the existing document job and notify both parties. Replays use the same event/document. Poll durable unresolved attempts after restart. Unknown statuses/timeouts remain unconfirmed. Cash may continue; any concurrent reduction in outstanding causes review rather than over-credit.

Only explicitly registered synthetic contracts are eligible, behind an opt-in development/test configuration. New method and PDFs say TEST. No production gateway endpoint or live switch exists. The gateway test merchant receives only simulated provider accounting; neither Nibash nor landlords receive real funds. No escrow, payout or legal settlement claim.

## E. Implemented changes (completed 2026-11-04)

The recommended external provider remains shurjoPay. Authentication and hosted-checkout initiation succeeded against its real sandbox. The returned hosted checkout could not be completed: the browser reported an unreachable page and its security policy blocked inspection. No alternate browser or policy bypass was attempted. **A successful external-provider payment has NOT been demonstrated.** The deliverable therefore defaults to the authorized internal simulation fallback, with the same attempt/verification/ledger processing and clearly different labels. This simulator is not a gateway and is not represented as official shurjoPay verification.

Files added:

- `db/migrations/020_payment_sandbox.sql:3`: synthetic-contract allowlist, durable attempts, simulated provider records, unique provider transaction identity, one unresolved attempt per invoice, TEST method constraints, browser-role revocations. `:41` implements atomic idempotent confirmation into existing payment events, invoices, document jobs, audit records and notifications. Existing methods retain their notification trigger; TEST events get explicit notifications for both parties. No existing financial record is rewritten.
- `server/src/services/shurjoPaySandbox.ts:5,12,38,122`: exact BDT minor units, fail-closed configuration, verification binding and bounded HTTPS adapter. Fixed sandbox endpoints and checkout-origin allowlist; no live mode. Only selected reconciliation fields are retained; no provider token/card/customer data in verification logs.
- `server/src/services/sandboxPayments.service.ts:41,136,152,160,252`: authoritative balance initiation, authorized verification scheduling, untrusted return wakeup, leased recovery worker and startup hook. Network calls occur outside financial transactions. Preflight failures are retryable; uncertain submission stays in review and never auto-creates another checkout.
- `server/src/services/simulatedPaymentProvider.ts:10,48`: persistent simulated provider outcomes, authenticated tenant-only test controls, asynchronous availability; the worker independently reads the simulated record before posting to the ledger.
- `server/src/routes/sandboxPayment.route.ts`: routes listed below; JWT checks for account operations; no-store responses; amount injection rejected.
- `server/src/paymentSandboxDemo.ts`: loopback-only demo server, persistent dedicated PGlite database, synthetic users/contracts, test-only banner, normal authentication and payment/receipt/income routes. It sets an unusable DATABASE_URL before loading services and binds the isolated database instead. It does not connect to the configured PostgreSQL server.
- `server/src/services/testing/sandboxDatabase.ts`: transaction-serialized PGlite pool adapter, used only by demo and tests.
- `client/src/components/SandboxPayment.tsx`: server-driven status polling, external checkout link, explicit simulated outcome controls, failures and reconciliation messages. Reopening a completed attempt refreshes parent balances.
- `server/src/services/sandboxPayments.test.ts`, `sandboxPayments.integration.test.ts`, `sandboxWorkflow.integration.test.ts`; `client/tests/sandboxPayment.test.tsx`: new verification/regression coverage.
- `server/.env.payment-sandbox.example`: disabled-by-default opt-in template, no private credentials.
- `docs/superpowers/plans/2026-11-03-payment-sandbox.md` and this report.

Existing files changed: `server/src/index.ts` mounts routes/worker and checks configuration before listening; `rentalManagement.service.ts` exposes synthetic eligibility/provider; `rentalDocuments.service.ts` adds TEST/simulation wording and compact TEST-only spacing; `server/package.json` adds `demo:payments`; `client/src/api/rentals.ts` adds optional eligibility fields; `RentalManagementPanel.tsx` embeds controls; `ContractDetailPage.tsx` refreshes its overlapping payment summary and labels TEST history; `.gitignore` excludes local demo databases/config. Existing unrelated changes, AI/search/area implementation, historical migrations and stored acknowledgments were preserved. The demo merely mounts the existing area read route for its shared navigation.

Routes under `/api/payment-sandbox`:

| Method/path | Behavior |
|---|---|
| GET `/config` | Authenticated enabled flag; no credentials. |
| POST `/payments/:id` | Tenant only, registered synthetic rent obligation only; empty body; server computes full remaining amount. Returns durable attempt ID. |
| GET `/payments/:id` | Tenant/current landlord attempt history; hosted URL only to tenant while pending. |
| POST `/attempts/:id/verify` | Authorized party queues verification only. Never charges or trusts client success. |
| GET/POST `/return?order_id=...` | Untrusted provider return hint; only schedules a stored pending order. Forged/duplicate hints cannot post money. |
| POST `/attempts/:id/simulate` | Simulated mode only; owning tenant selects succeeded/failed/cancelled and optional 2–120 second delay. First outcome wins. |

The online amount is the full server-computed remainder. Partial cash installments already recorded are deducted; this slice does not add an arbitrary online installment amount field. A pending cash claim blocks new checkout. If a cash confirmation changes the balance after checkout began, successful external verification goes to reconciliation instead of over-crediting. Unknown provider status and timeouts remain pending; one-hour waits move to review, **not an invented provider failure/expiry**. A known provider order can be checked again. An uncertain submission without a saved provider order requires operator reconciliation with the provider; this slice intentionally has no unsafe reset/recharge button.

## F. Actual test results

`npm test` in server: **161 passed, 0 failed**. This default suite uses isolated fixtures and explicitly excludes legacy tests that write to DATABASE_URL. `npm test` in client: **30 passed, 0 failed**. Both TypeScript/app builds passed. Vite reports the existing large bundle advisory. The focused concurrent UI run printed an HMR-port warning; the full sequential client run passed without that warning. Independent source review found two recovery/UI issues and one misleading simulated-PDF footer; all were corrected and retested.

| Required scenario | Evidence/result |
|---|---|
| Successful payment | Simulated provider + real SQL/HTTP/PDF pipeline passed; successful shurjoPay hosted transaction **not completed**. |
| Failed/cancelled | Simulated integration tests pass with no paid event; failed-then-success demonstrated through the running local API. |
| Duplicate callback | Repeated return hints do not post money; one attempt/event/document. |
| Forged/invalid callback | Unknown order hints cannot confirm; browser return alone leaves full outstanding. |
| Amount mismatch | Adapter and SQL confirmation reject mismatch; worker quarantines it. |
| Currency mismatch | USD evidence rejected/quarantined. |
| Another tenant/payment | Ownership checks and HTTP 403/401; non-allowlisted contracts rejected. |
| Already paid | New initiation rejected after zero balance. |
| Partial payment | Cash 30 + simulated remainder 70 = income 100 and outstanding 0; separate SQL test covers TEST 40 + cash 60. |
| Duplicate verification | Competing async workers and repeated scheduling yield one event/document. |
| Delayed verification | Persisted delayed outcome remains unpaid until available; injected timeout never creates success. |
| Backend restart | Actual local demo process stopped/restarted after checkout creation; same persisted attempt then completed through UI. Expired lease test also passes. |
| Receipt failure/recovery | Injected renderer error leaves confirmed ledger intact and queued document; retry produces downloadable real PDF. |
| Unauthorized payment/receipt | JWT requirement, unrelated-owner 403, browser-role DB denial, and authorized PDF download tested. |
| Cash regression | Existing cash/installment/reversal/advance/document/HTTP suites pass. |
| Reconciliation | SQL view and running landlord API match tenant amounts; after two separate BDT 100 synthetic invoices, landlord total is 200, both balances zero. |

Important limits: PGlite is PostgreSQL-compatible execution, **not a multi-session PostgreSQL concurrency test**. Its adapter serializes transactions; source lock ordering was reviewed, but a deployed PostgreSQL race/load test remains required. Provider mismatch/timeout tests inject responses or use the local simulator. No real bank/mobile wallet was charged. No provider refund, production settlement, hosted IPN delivery, multi-landlord payout or live deployment was tested. Browser end-to-end verification covers the simulation, not successful shurjoPay checkout.

Artifacts: `output/payment-sandbox/demo-evidence.json` records synthetic before/after amounts and income; `simulated-acknowledgment.pdf` is the actual downloaded acknowledgment from the running demo. The final PDF was rendered and inspected: one A4 page, explicit simulation wording, no overlapping or clipped fields. Earlier immutable database PDFs remain retained; the output sample was refreshed from a new synthetic event.

## G. Repeatable judge demonstration

Use the isolated demo below; do not point a test demo at existing real obligations. From repository root in PowerShell, with normal dependencies installed (`npm ci --prefix server` and `npm ci --prefix client` only if needed):

```powershell
$env:VITE_API_URL='http://127.0.0.1:5055/api'
npm run build --prefix client -- --outDir dist/sandbox
Remove-Item Env:VITE_API_URL
$env:PAYMENT_SANDBOX_PROVIDER='simulated'
npm run demo:payments --prefix server
```

1. Open `http://127.0.0.1:5055/login`. Sign in as `tenant@example.test`, password `NibashDemo2026!`. These credentials exist only in the synthetic loopback demo.
2. Open `/contracts/1`, select **Payments** in “Protection, documents & payments.” A fresh database contains a BDT 100 rent invoice. The top banner and payment controls explicitly say simulation/no money transferred.
3. Select **Start simulated checkout**. Demonstrate **Simulate failed** or **Simulate cancelled** first: outstanding remains 100, no paid acknowledgment appears.
4. Start a new attempt, select **Simulate succeeded**. It remains pending until the verification worker reads the separate provider record; status polling updates automatically. Normal response takes roughly 5–20 seconds, not an instantaneous client-side paid flag.
5. Show zero outstanding, the “Simulated TEST” event and **Download acknowledgment**. PDF worker runs every five seconds; if download returns 202, retry shortly. Show the TEST banner and explicit simulator wording in the PDF.
6. Show the tenant inbox notification. Sign out using the profile menu, then sign in as `owner@example.test` with the same demo password. Visit `/contracts/1` for the same event/PDF, and `/owner/income` for matching “Simulated TEST” ledger history. All pages retain the demo banner. Final browser verification showed two entries totaling BDT 200; evidence is saved in `output/payment-sandbox/landlord-income-demo.png`.
7. For another run, stop the server with Ctrl+C and run `npm run demo:payments --prefix server -- --new-invoice`. This appends another synthetic BDT 100 obligation; it never deletes old evidence. Do not expect the ID to be 2: database sequence values can skip after restart.
8. Restart recovery demo: create an attempt, stop/restart without `--new-invoice`, reopen Payments, then choose the simulated outcome. State survives in `server/.payment-sandbox-data-v2`. Never share this local database or its fixed demo JWT key as a hosted deployment.

The demo has fixed synthetic dates for the November 5, 2026 submission. The earlier shurjoPay connectivity probe is retained separately in the ignored `.payment-sandbox-data` directory. The latest sample evidence uses two completed invoices; add a new invoice to show the unpaid starting state.

To exercise the **single implemented genuine provider** later, set `PAYMENT_SANDBOX_PROVIDER=shurjopay-sandbox`, then server-side `SHURJOPAY_SANDBOX_USERNAME`, `SHURJOPAY_SANDBOX_PASSWORD`, and `SHURJOPAY_SANDBOX_PREFIX` from the [official shared-sandbox page](https://shurjopay.com.bd/frontend-developers/integration-howto). Restart, append a new synthetic invoice, choose **Pay Online — Sandbox**, then **Open sandbox checkout**. Do not reuse a pending simulated invoice when switching providers. No source replacement or second gateway integration is needed. A successful transaction must still pass independent verification before the same ledger function runs. If the hosted site is inaccessible, stay with the labeled simulation; do not invent success or switch to a live URL.

## H. Deployment readiness

Nothing was deployed, pushed or committed. The normal app remains disabled unless `PAYMENT_SANDBOX_ENABLED=true` and `NODE_ENV` is exactly `development` or `test`; unknown provider names and production-mode opt-in are rejected. Normal operation without the flag does not query the new tables. The demo runner separately refuses a production NODE_ENV, binds loopback only and uses synthetic storage. There is no live adapter or production endpoint configuration.

For a hosted **sandbox-only** environment: provision a separate synthetic PostgreSQL database, apply migration 020 after 019, seed synthetic accounts/contracts/obligations and explicitly insert only those contract IDs into `sandbox_contracts`; configure the server JWT/DB credentials, sandbox opt-in/provider/credentials, a reachable HTTPS `PAYMENT_SANDBOX_RETURN_URL` ending `/api/payment-sandbox/return`, and the client API origin. Run the verification and document workers continuously; preserve database storage across restart. Restrict access to demo participants. The local fixed-password demo runner is not a hosted deployment recipe. Configure/validate actual provider IPN delivery with support separately; the current durable polling path does not depend on a browser return being received.

Before any live operation: explicit authorization; approved merchant/marketplace agreement; validated money recipient and payout flow; separate live implementation/configuration; real PostgreSQL concurrency/load testing; secure DB TLS configuration; reconciliation/refund operations; production access/rate limits, monitoring and credential management. None is implied by successful sandbox tests.

## I. Remaining business/legal questions

- Who is the contracted merchant and bank-account beneficiary? Sandbox store 1 represents the provider test merchant only. It proves neither Nibash custody nor landlord settlement.
- Does the provider authorize collecting independent landlords' rent through one platform merchant, or must each landlord onboard? Obtain written classification/approval, not an inference from “submerchant agreement” terminology.
- Are split settlements, submerchant APIs and landlord payouts contracted/enabled, with KYC and beneficiary validation? No such entitlement was established here. bKash's payout product does not itself answer this question.
- What are actual merchant fees, taxes, reserves, settlement timing, disputes, chargebacks and refund responsibilities? Only SSLCOMMERZ's published standard rates were verified; quotations/contracts govern the others.
- Who reconciles bank settlement against verified gross tenant payments and fees? A provider success is not proof of payout to a landlord. A local reversal is not a provider refund.
- What onboarding organization/age/eligibility requirements apply to the applicant? Reviewed public pages did not settle all eligibility conditions; no account or approval requirement was bypassed.
- Who issues any legally required rent receipt and handles the landlord/tenant agreement? The PDF remains an electronic record, not certified escrow, a legal-validity certificate or a payout guarantee.
