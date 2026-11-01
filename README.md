# Nibash

A Verified Apartment Rental Marketplace

Project for CSE216: Database Systems

## Overview

Renting an apartment in Bangladesh almost always runs through a broker, an advance payment handed over before anything is verified, and listings that may already be taken. Nibash treats this as a data and trust problem: landlords list apartments, tenants search and apply across multiple filters, and the system layers in fraud-detection signals, an explicit rent-payment ledger, and audit logging so that every sensitive action is traceable.

## Tech Stack (PERN)

- **P - PostgreSQL**: relational database
- **E - Express**: Node.js backend framework, using the raw `pg` driver (no ORM) so every query and transaction is explicit SQL
- **R - React**: frontend, built with Vite, communicating with the backend over a JSON REST API
- **N - Node.js**: JavaScript runtime for the backend

**Planned:** free-tier multimodal AI API for deed/receipt document extraction; bKash sandbox API for simulated wallet-based identity verification.

## User Roles

- **Landlord** - lists properties, manages applications, signs leases
- **Tenant** - searches listings, applies, manages an active lease and rent payments
- **Admin / Verifier** - reviews flagged listings and confirms ownership documents

## Core Features

- Hand-rolled authentication (custom password hashing + session/JWT issuance and verification)
- Server-side role-based access control enforced on every protected request
- Dimensional listing schema (Area → Building → PropertyType → Amenity) with multi-filter search
- Landlord and Tenant profiles; rental application / viewing-request workflow
- Lease creation, recurring rent ledger, and security deposit lifecycle (held → deducted → refunded)
- Reviews of buildings/landlords after a completed lease
- Duplicate-listing detection trigger (same address/Khatian number claimed by two accounts)
- Audit/shadow-logging trigger for sensitive status changes
- Report-threshold auto-flagging trigger for repeatedly reported listings
- Explicit `BEGIN ... COMMIT` / `ROLLBACK` transaction control on every multi-step DML operation

### Planned

- AI-assisted Dolil/tax-receipt field extraction (vision-model API)
- Mobile-wallet (bKash/Nagad sandbox) payment-based identity cross-check
- Computed landlord "trust score"

## Getting Started

### Prerequisites

- Node.js (LTS)
- PostgreSQL
- npm

### Project Structure

```
nibash/
├── client/          # React (Vite) frontend
├── server/          # Express backend (raw pg, no ORM)
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/   # auth + RBAC checks
│   │   ├── db/           # pg pool, queries, migrations
│   │   └── triggers/     # SQL trigger definitions
│   └── package.json
├── db/
│   └── migrations/  # Ordered PostgreSQL schema migrations
└── README.md
```

### Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/kazimdraiyan/Nibash.git
   cd nibash
   ```

2. **Set up PostgreSQL**

   ```bash
   createdb nibash
   ```

   On this **new, empty database only**, run the SQL files in `db/migrations/`
   in numeric order (001–015), stopping on errors. Older bootstrap migrations
   contain destructive statements; never replay them on an existing database.
   For an existing installation through 014, apply only 015 after a backup.
   Document storage also requires the Supabase setup and legacy-file migration
   in [the document deployment guide](docs/document-verification-fixes.md).

3. **Configure environment variables**

   Create a `.env` file in `server/`:

   ```
   DATABASE_URL=postgres://user:password@localhost:5432/nibash
   JWT_SECRET=your-hmac-secret
   PORT=5000
   ```

4. **Install dependencies**

   ```bash
   cd server
   npm ci

   cd ../client
   npm ci
   ```

5. **Run the app**

   ```bash
   # Backend (from /server)
   npm run dev

   # Frontend (from /client)
   npm run dev
   ```

### Document verification

Documents use private storage, versioned human reviews, and a PostgreSQL-backed
screening queue. Copy the storage and Gemini settings from `server/.env.example`.
Run the backend as a persistent process so its worker can recover queued jobs.
See [changes, test evidence, tradeoffs, and deployment steps](docs/document-verification-fixes.md).

From `server/`, `npm test` runs isolated tests with synthetic credentials and an
embedded PostgreSQL database. The older `src/services/__tests__/` suites require
a separately provisioned disposable database and are excluded from that command.

## License

TBD
