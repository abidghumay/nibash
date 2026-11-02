# Live inbox database rollout — 2 November 2026

Applied under the owner's explicit request to inspect the live database first and
apply the latest missing migrations.

## Inspection

The configured live Supabase PostgreSQL 17.6 database already satisfied migration
016: monthly billing selected signed contracts within their dates; billing-month
columns and the unique contract/month index existed. Both the monthly billing and
overdue-payment cron jobs were enabled. No duplicate contract/month rows existed.
Migration 016 was therefore not replayed. The inbox table/functions did not exist.

Supabase's default privileges granted new public tables to `anon` and
`authenticated`. Migration 017 was hardened before application with row-level
security and explicit revocation of browser/public table, sequence and function
access. Nibash's own authenticated API uses the existing owner database connection.
An isolated test reproduces these default grants and verifies they are removed.

## Application and verification

- A fresh custom-format database backup was created and its archive listed and
  fully decoded successfully before application. This checks archive readability;
  a restore to a separate database was not performed.
- Migration 017 committed at **22:29:50 Asia/Dhaka**. Its SHA-256 was
  `fd3a905f83c61357d401241c83da88b93c25c4966551a38dff4b77310b994fb2`.
- Backfill created **5 payment-created messages** for outstanding payments.
  No signed contracts were inside the calendar-month expiry window at application.
- Two repeated reminder runs created no additional messages.
- Both payment and contract notification triggers were enabled.
- Existing records were unchanged: **15 users, 4 contracts, 12 payments,
  34 documents**. Whole-row fingerprints were identical before and after.
- A fresh connection verified committed messages, triggers, unchanged business
  records and both active payment schedules at **22:30:23 Asia/Dhaka**.
- Actual `SET LOCAL ROLE` read probes confirmed permission denied for both
  `anon` and `authenticated`; the API owner connection can access the inbox.
- All **66 isolated server tests** and the server TypeScript build passed.

Private backup directory:
`C:/Users/Abid/.codex/backups/nibash-inbox-rollout-20261102`

The backup contains `database.dump` (417,276 bytes, 633 archive entries), decoded
validation SQL, its manifest, before/application/post-commit reports, and operation
scripts. Backup SHA-256:
`e067cc8f444e26ba01814d93255395c75dc72374cd2e7e35435bf94ed7d988fe`.
These private artifacts are outside the repository. Do not replay the application
script or restore the backup over live data blindly.

This rollout changed the database only. The updated frontend/API must still be
deployed for the inbox UI and API's startup/daily expiry checks to run in production.
The existing database monthly-payment job will create inbox messages through the
new payment trigger independently of that app deployment.
