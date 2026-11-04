# Nibash Phase 2 condition inspection demo

This local demo uses the real Nibash login, condition-report, inspection, rental lifecycle and notification APIs. It seeds a confirmed synthetic living-room baseline through the existing Phase 1 service, then leaves move-out initiation, upload, analysis, human review and approval for the presenter. No production database, Supabase storage or deployment is used.

Fresh runs also include one unpaid synthetic Tk 100 invoice so presenters can show that condition approval leaves financial records unchanged. The recorded earlier live run had no seeded invoice; payment preservation was checked separately by integration tests and the later fixture HTTP walkthrough.

## Start a fresh demonstration

From the repository root in PowerShell, build the actual client for the same-origin local API:

```powershell
$env:VITE_API_URL='/api'
npm --prefix client run build -- --outDir dist/condition-demo
Remove-Item Env:VITE_API_URL
```

For genuine Gemini comparison of the project-authored synthetic images, use the existing server `.env` with its Gemini API key. Never paste that key into the terminal output, frontend or presentation.

```powershell
Set-Location server
npx tsx src/scripts/conditionInspectionDemo.ts --live-synthetic --fresh
```

For an explicitly labelled offline fallback:

```powershell
Set-Location server
npx tsx src/scripts/conditionInspectionDemo.ts --fixture --fresh
```

Open [the local contract](http://127.0.0.1:5056/contracts/1). The page banner identifies **LIVE GEMINI** or **FIXTURE FALLBACK**. Omitting both inference flags selects the labelled fixture fallback. Do not describe that mode as live inference.

| Role | Email | Password |
| --- | --- | --- |
| Tenant | `condition-tenant@example.test` | `NibashCondition2026!` |
| Landlord | `condition-owner@example.test` | `NibashCondition2026!` |
| Unrelated owner, access-denial check | `condition-other@example.test` | `NibashCondition2026!` |

The runner binds only `127.0.0.1:5056`. A dedicated ignored folder under `server/.condition-inspection-demo-data-v1*` stores PGlite data and private image files. `--fresh` creates another directory and prints a 13-digit run ID; `--resume <run ID>` reopens that exact run, retaining evidence, approvals and notifications. Omitting both options uses a fixed persistent directory. Stop with Ctrl+C; do not start two processes on the same database directory.

## Six-scene walkthrough

1. **Confirmed baseline.** Log in as tenant and open contract 1. Show the locked Phase 1 Living room report, the two confirmations and its original synthetic baseline image. The recording date is actual; the seed does not invent historical timestamps.
2. **New evidence.** Click **Start move-out inspection**. Choose the Living room and corresponding move-in photograph. Upload `output/condition-vision/04-wall-mark.png` using **Upload photograph**. Both original photographs remain accessible side by side. The same authored file is also viewable at [the synthetic wall-mark fixture](http://127.0.0.1:5056/demo-fixtures/04-wall-mark.png).
3. **AI analysis.** Read the external processing disclosure. In the baseline panel, first select **I checked this baseline: its photographs and notes contain no identity documents or unrelated sensitive personal details**, then grant baseline comparison permission. Both tenant and landlord must do this for the exact confirmed baseline. In the move-out panel, explicitly select the external-processing permission (which also confirms no identity documents) and click **Analyze Condition**. Switch to landlord, grant baseline permission and **Permit submitted evidence analysis**, then click **Analyze submitted evidence**. Both parties must consent to the exact frozen input before a durable job may run. While processing, show the persistent status. Live mode submits the two synthetic image copies to Gemini. Fixture mode returns text labelled **FIXTURE FALLBACK** and performs no inference.
4. **Human inspection.** As landlord, inspect each finding and its photographs. Choose **No issue found** or **Acceptable condition / ordinary wear** and **Save review**. Describe the observation as a possible visible change, not proof of damage or responsibility. Add an independent manual observation if appropriate. A confirmed issue leads to an audited review/dispute path; it does not deduct money or unilaterally resolve liability.
5. **Vacancy and approval.** As tenant, explicitly confirm the apartment is vacated, choose the actual date and click **Record physical vacancy**. As landlord, review the exact acceptance statement, confirm physical inspection/acceptance and click **Approve Move-Out**. Every required finding must be reviewed. Approval before tenant vacancy remains awaiting tenant confirmation. Once both requirements are satisfied, the backend atomically completes the inspection through the existing controlled rental closure.
6. **Tenant confirmation.** Log back in as tenant. Show the completed inspection, preserved evidence, history and Notification Center entries. Revisit the contract: the occupancy is closed, and historical payment records remain intact.

For another presentation run, stop the process and restart with `--fresh`. Contract 2 is a separate synthetic tenancy without a baseline: it supports manual rooms, photographs, physical inspection and approval, and explicitly states that no comparable baseline exists.

For a repeatable automated API walkthrough, start a fresh **fixture** run, then in another terminal at the repository root run:

```powershell
node output/condition-phase-two/demo-http-walkthrough.cjs
```

This performs actual HTTP login, multipart upload, signed image checks, consent, durable-worker execution, review, approval, vacancy and completion checks. It writes `demo-http-results.json` and deliberately labels its model portion as an injected fixture. Use a fresh run because the script finishes contract 1.

## What is simulated

- Users, rental records and photographs are synthetic. PGlite substitutes for the production PostgreSQL service. Evidence uses private local disk, protected by short-lived signed tickets, in place of Supabase.
- The normal application routes and version checks, database migration rules, review workflow, occupancy transition and notification persistence execute locally.
- **Live mode:** actual Gemini calls, actual model/schema response, measured provider runtime and reported token usage. This remains a synthetic feasibility demonstration, not proof of performance on private homes.
- **Fixture mode:** an injected deterministic comparison fallback, clearly labelled in the banner and returned finding/summary/model metadata. It is not model evaluation evidence. Non-mark fixtures may return an empty example response; use the wall-mark fixture for the fallback walkthrough.
- The demo worker checks normalized input SHA-256 hashes before invoking any provider. It accepts the seeded synthetic baseline and the six original authored move-out fixture variants only. Arbitrary uploaded photographs cannot use the synthetic provider bypass. They can be handled with manual inspection. Production image-processing configuration is not changed.

## Repeat the vision evaluation

From `server`:

```powershell
$evaluationOutput='../output/condition-phase-two-repeat-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
npx tsx src/scripts/evaluateMoveOutVision.ts --synthetic --out $evaluationOutput
```

The script uses the production Phase 2 comparator and the six original images in `output/condition-vision`. It writes `expectations.json` in the selected new output directory before the first inference, then incrementally persists `results.json`, including actual response text, model, runtime, API and usage. It refuses a directory with existing results and never overwrites the Phase 1 artifacts. `--expectations-only` writes the protocol without making a model request. The original v2 attempt remains in `output/condition-phase-two`; the complete tightened v3 run is in `output/condition-phase-two-v3`.

Cases 7 (no baseline) and 8 (provider unavailable) are backend integration scenarios. Their evidence must identify test doubles and must never be represented as live inference or an observed provider outage. See the Phase 2 evaluation review for actual results and limitations.

## Presentation claims

“Nibash uses multimodal AI to suggest visible changes between rental-property photographs and organizes those suggestions for landlord review.”

“Humans review the evidence, record physical vacancy and approve move-out. AI does not determine liability, costs or deposit deductions.”

The six-pair synthetic evaluation is a limited feasibility check, not an accuracy benchmark. Text findings and side-by-side photographs are the selected interface: Phase 1 localization was unreliable, so the product does not draw model-generated boxes or fabricate highlighted regions.

## Production boundaries

Do not deploy this runner or its published test credentials. It deliberately substitutes an invalid loopback `DATABASE_URL`, disables external storage configuration and uses a local demo JWT signing key. Only this process enables its local AI submission gate, with the restricted evaluator injected. Normal production processing retains its operator gate, consent, private evidence access and worker configuration. Production rollout still requires migrations, verified private storage, external-processing consent/retention decisions and operational worker monitoring.
