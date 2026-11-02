import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const migrations = resolve(__dirname, "../../../db/migrations");

for (const upgrade of [false, true]) {
  test(`monthly payments bill only current signed contracts (${upgrade ? "existing database upgrade" : "fresh install"})`, async (t) => {
    const db = new PGlite({ extensions: { pg_trgm } });
    t.after(() => db.close());
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql") && n < "016").sort()) {
      await db.exec((await readFile(resolve(migrations, name), "utf8")).replace(/^\uFEFF/, ""));
    }
    await db.exec(`
      INSERT INTO users (name,nid,phone,password_hash) VALUES ('Owner','1','1','x'),('Tenant','2','2','x');
      INSERT INTO owners VALUES (1);
      INSERT INTO tenants VALUES (2,50000,'3');
      INSERT INTO areas (name,city,latitude,longitude,radius) VALUES ('Test','Dhaka',1,1,1);
      INSERT INTO listings (title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
        VALUES ('Flat','Test',1,1,2,1,1,1,1);
      INSERT INTO terms (rent,electricity_bill,water_bill,service_charge,monthly_due_date)
        SELECT 10000,500,NULL,1000,5 FROM generate_series(1,5);
      INSERT INTO agreements SELECT id FROM terms;
      INSERT INTO contracts (tenant_id,listing_id,agreement_id,status,start_date,end_date) VALUES
        (2,1,1,'signed',CURRENT_DATE-30,CURRENT_DATE+30),
        (2,1,2,'proposed',CURRENT_DATE-30,CURRENT_DATE+30),
        (2,1,3,'completed',CURRENT_DATE-30,CURRENT_DATE+30),
        (2,1,4,'signed',CURRENT_DATE+1,CURRENT_DATE+30),
        (2,1,5,'signed',CURRENT_DATE-30,CURRENT_DATE-1);
    `);
    if (upgrade) {
      // Reproduce the procedure installed by older releases before upgrading it.
      const original = await readFile(resolve(migrations, "011_payment_procedure.sql"), "utf8");
      await db.exec(original.replace("WHERE c.status = 'signed'", "WHERE c.status = 'active'"));
      await db.exec("CALL generate_monthly_payments()");
      assert.equal((await db.query("SELECT * FROM payments")).rows.length, 0);
      await db.exec("DROP INDEX uq_payment_contract_month");
      await db.exec(await readFile(resolve(migrations, "016_fix_monthly_payment_contract_status.sql"), "utf8"));
    }
    await db.exec("CALL generate_monthly_payments(); CALL generate_monthly_payments();");
    const result = await db.query(`SELECT contract_id,amount::text,status,
      billing_month = date_trunc('month',CURRENT_DATE)::date AS correct_month,
      due_date = (date_trunc('month',CURRENT_DATE) + interval '4 days')::date AS correct_due
      FROM payments`);
    assert.deepEqual(result.rows, [{ contract_id: 1, amount: "11500", status: "pending", correct_month: true, correct_due: true }]);
    await assert.rejects(db.exec("UPDATE contracts SET status='active' WHERE id=1"), /check constraint/i);
  });
}
