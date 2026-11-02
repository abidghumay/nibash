import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
const migrations = resolve(__dirname, "../../../../db/migrations");
export async function rentalDatabase(browserGrants = false) {
  const db = new PGlite({ extensions: { pg_trgm } });
  for (const name of (await readdir(migrations))
    .filter((n) => n.endsWith(".sql") && n < "018")
    .sort()) {
    await db.exec(
      (await readFile(resolve(migrations, name), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
  }
  await db.exec(`INSERT INTO users(name,nid,phone,password_hash) VALUES
    ('Synthetic Owner','SYNTH-1','SYNTH-1','x'),('Synthetic Tenant','PRIVATE-NID-2','SYNTH-2','x'),('Other Owner','SYNTH-3','SYNTH-3','x');
    INSERT INTO owners VALUES(1),(3); INSERT INTO tenants VALUES(2,50000,'SYNTH-EMERGENCY');
    INSERT INTO areas(name,city,latitude,longitude,radius) VALUES('Synthetic area','Dhaka',1,1,1);
    INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
      SELECT 'Synthetic unit '||n,'Test only',1,1,2,1,n,1,1 FROM generate_series(1,5) n;
    INSERT INTO terms(rent,security_deposit,monthly_due_date) VALUES(20000,5000,5);
    INSERT INTO agreements VALUES(1);
    INSERT INTO contracts(tenant_id,listing_id,agreement_id,status,start_date,end_date)
      VALUES(2,5,1,'signed','2025-01-01','2026-01-01');`);
  if (browserGrants)
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon,authenticated;`);
  await db.exec(
    await readFile(resolve(migrations, "018_rental_protection.sql"), "utf8"),
  );
  return db;
}

export async function proposed(
  db: PGlite,
  listing = 1,
  rent = "20000",
  start = "2026-11-15",
  end = "2027-11-14",
  previous?: number,
) {
  const terms = await db.query<{ id: number }>(
    `INSERT INTO terms(rent,security_deposit,advance_rent,monthly_due_date)
    VALUES($1,0,0,5) RETURNING id`,
    [rent],
  );
  const id = terms.rows[0].id;
  await db.query("INSERT INTO agreements VALUES($1)", [id]);
  return (
    await db.query<{ id: number }>(
      `INSERT INTO contracts(tenant_id,listing_id,agreement_id,start_date,end_date,created_by_id,previous_contract_id)
    VALUES(2,$1,$2,$3,$4,1,$5) RETURNING id`,
      [listing, id, start, end, previous ?? null],
    )
  ).rows[0].id;
}
