/** Local synthetic demo. Never connects to DATABASE_URL; data stays in a dedicated PGlite directory. */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";

async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo cannot run in production");
  process.env.NODE_ENV = "development";
  process.env.PAYMENT_SANDBOX_ENABLED = "true";
  process.env.PAYMENT_SANDBOX_PROVIDER ??= "simulated";
  process.env.DATABASE_URL =
    "postgres://disabled:disabled@127.0.0.1:1/never_connect";
  process.env.JWT_SECRET = "local-synthetic-demo-only-not-for-deployment";
  process.env.PAYMENT_SANDBOX_RETURN_URL =
    "http://127.0.0.1:5055/api/payment-sandbox/return";
  const directory = resolve(__dirname, "../.payment-sandbox-data-v2");
  await mkdir(directory, { recursive: true });
  const db = new PGlite(directory, { extensions: { pg_trgm } });
  // Never replay old destructive migrations against a nonempty database.
  const schema = (
    await db.query<{ name: string | null }>(
      "SELECT to_regclass('public.users') AS name",
    )
  ).rows[0].name;
  if (!schema) {
    const migrations = resolve(__dirname, "../../db/migrations");
    for (const name of (await readdir(migrations))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await db.exec(
        (await readFile(resolve(migrations, name), "utf8")).replace(
          /^\uFEFF/,
          "",
        ),
      );
    const password = await bcrypt.hash("NibashDemo2026!", 10);
    await db.query(
      `INSERT INTO users(name,email,nid,phone,password_hash) VALUES
      ('TEST Landlord','owner@example.test','TEST-OWNER','TEST-OWNER',$1),
      ('TEST Tenant','tenant@example.test','TEST-TENANT','TEST-TENANT',$1),
      ('TEST Other Owner','other@example.test','TEST-OTHER','TEST-OTHER',$1)`,
      [password],
    );
    await db.exec(`INSERT INTO owners VALUES(1),(3);INSERT INTO tenants VALUES(2,50000,'TEST-EMERGENCY');
      INSERT INTO areas(name,city,latitude,longitude,radius) VALUES('TEST area','Dhaka',23.8,90.4,1);
      INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
        VALUES('TEST sandbox apartment','Synthetic payment demonstration only',23.8,90.4,2,1,2,1,1);
      INSERT INTO terms(rent,security_deposit,advance_rent,monthly_due_date) VALUES(100,0,0,5);
      INSERT INTO agreements VALUES(1);
      INSERT INTO contracts(tenant_id,listing_id,agreement_id,start_date,end_date,created_by_id)
        VALUES(2,1,1,'2026-11-01','2027-10-31',1);
      UPDATE contracts SET status='signed' WHERE id=1;
      INSERT INTO sandbox_contracts(contract_id) VALUES(1);
      INSERT INTO payments(contract_id,amount,due_date) VALUES(1,100,'2026-11-05');`);
  } else if (
    !(
      await db.query<{ name: string | null }>(
        "SELECT to_regclass('public.payment_attempts') AS name",
      )
    ).rows[0].name
  ) {
    throw new Error(
      "Unexpected demo database schema; use a fresh dedicated directory",
    );
  }
  if (process.argv.includes("--new-invoice"))
    await db.exec(
      "INSERT INTO payments(contract_id,amount,due_date) VALUES(1,100,'2026-11-05')",
    );
  const { bindSandboxDatabase } = await import(
    "./services/testing/sandboxDatabase.js"
  );
  bindSandboxDatabase(db);
  const app = express();
  app.use(cors({ origin: ["http://127.0.0.1:5055", "http://localhost:5173"] }));
  app.use(express.json());
  for (const [path, module] of [
    ["auth", "auth"],
    ["contracts", "contract"],
    ["payments", "payment"],
    ["rental", "rental"],
    ["payment-sandbox", "sandboxPayment"],
    ["notifications", "notification"],
    ["areas", "area"],
    ["owners/me/income", "income"],
  ] as const) {
    const router = await import("./routes/" + module + ".route.js");
    app.use("/api/" + path, router.default);
  }
  app.use("/api", (_req, res) => {
    res
      .status(404)
      .json({ error: "This endpoint is outside the isolated payment demo" });
  });
  const assets = resolve(__dirname, "../../client/dist/sandbox");
  app.use(express.static(assets, { index: false }));
  app.get("/{*path}", async (_req, res) => {
    const html = await readFile(resolve(assets, "index.html"), "utf8");
    const banner =
      process.env.PAYMENT_SANDBOX_PROVIDER === "simulated"
        ? "SIMULATED PAYMENT DEMO"
        : "SHURJOPAY SANDBOX DEMO";
    res
      .type("html")
      .send(
        html.replace(
          /(<body[^>]*>)/,
          '$1<aside style="padding:12px 24px;background:#fff3ce;color:#3c2900;text-align:center;font:600 16px system-ui">' +
            banner +
            " — no real money transferred. Synthetic records only.</aside>",
        ),
      );
  });
  const { startSandboxPaymentWorker } = await import(
    "./services/sandboxPayments.service.js"
  );
  const { startRentalDocumentWorker } = await import(
    "./services/rentalDocuments.service.js"
  );
  const stopPayments = startSandboxPaymentWorker(),
    stopDocuments = startRentalDocumentWorker();
  const server = app.listen(5055, "127.0.0.1", () =>
    console.log(
      "Synthetic sandbox demo: http://127.0.0.1:5055 — tenant@example.test / owner@example.test; password NibashDemo2026!; contract /contracts/1",
    ),
  );
  const stop = () => {
    stopPayments();
    stopDocuments();
    server.close(() => void db.close().then(() => process.exit(0)));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
void main().catch(() => {
  console.error(
    "Sandbox demo startup failed; check configuration and dedicated demo database",
  );
  process.exitCode = 1;
});
