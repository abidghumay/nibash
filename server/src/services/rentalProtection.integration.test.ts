import assert from "node:assert/strict";
import test from "node:test";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";

test("rental policy migration and financial protection use real PostgreSQL", async (t) => {
  const db = await rentalDatabase();
  t.after(() => db.close());
  await t.test(
    "historical deposits and uncertain tenancy metadata remain explicit",
    async () => {
      assert.deepEqual(
        (
          await db.query(
            `SELECT protection_state,initial_rent,tenancy_started_on FROM contracts WHERE id=1`,
          )
        ).rows,
        [
          {
            protection_state: "needs_verification",
            initial_rent: null,
            tenancy_started_on: null,
          },
        ],
      );
      assert.equal(
        (
          await db.query<{ security_deposit: string }>(
            "SELECT security_deposit::text FROM terms WHERE id=1",
          )
        ).rows[0].security_deposit,
        "5000",
      );
    },
  );
  const id = await proposed(db);
  await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [id]);
  await t.test(
    "effective start establishes calendar protection, no invented signature",
    async () => {
      assert.deepEqual(
        (
          await db.query(
            `SELECT initial_rent::text,tenancy_started_on::text,protection_until::text,protection_state FROM contracts WHERE id=$1`,
            [id],
          )
        ).rows,
        [
          {
            initial_rent: "20000",
            tenancy_started_on: "2026-11-15",
            protection_until: "2028-11-15",
            protection_state: "verified",
          },
        ],
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE contract_id=$1 AND kind='agreement'",
            [id],
          )
        ).rows.length,
        1,
      );
    },
  );
  await t.test(
    "ordinary advance allowed, excess advance and new deposit blocked at database boundary",
    async () => {
      await db.exec(
        "INSERT INTO terms(rent,advance_rent,security_deposit) VALUES(20000,20000,0)",
      );
      await assert.rejects(
        db.exec(
          "INSERT INTO terms(rent,advance_rent,security_deposit) VALUES(20000,40000,0)",
        ),
        /Controller/,
      );
      await assert.rejects(
        db.exec("INSERT INTO terms(rent,security_deposit) VALUES(20000,1)"),
        /security deposit/i,
      );
      await assert.rejects(
        db.exec("UPDATE terms SET security_deposit=6000 WHERE id=1"),
        /immutable|security deposit/i,
      );
    },
  );
  await t.test(
    "12 months and day before anniversary rejected; anniversary proposal needs acceptance",
    async () => {
      for (const date of ["2027-11-15", "2028-11-14"])
        await assert.rejects(
          db.query("SELECT propose_rent_revision(1,$1,21000,$2)", [id, date]),
          /24-month/,
        );
      await assert.rejects(
        db.query("SELECT propose_rent_revision(3,$1,21000,'2028-11-15')", [id]),
        /authorized/i,
      );
      const revision = (
        await db.query<{ propose_rent_revision: number }>(
          "SELECT propose_rent_revision(1,$1,21000,'2028-11-15')",
          [id],
        )
      ).rows[0].propose_rent_revision;
      assert.equal(
        (
          await db.query<{ rent: string }>(
            "SELECT effective_contract_rent($1,'2028-11-15')::text AS rent",
            [id],
          )
        ).rows[0].rent,
        "20000",
      );
      await assert.rejects(
        db.query("SELECT accept_rent_revision(3,$1,true)", [revision]),
        /authorized/i,
      );
      await db.query("SELECT accept_rent_revision(2,$1,true)", [revision]);
      assert.equal(
        (
          await db.query<{ rent: string }>(
            "SELECT effective_contract_rent($1,'2028-11-14')::text AS rent",
            [id],
          )
        ).rows[0].rent,
        "20000",
      );
      assert.equal(
        (
          await db.query<{ rent: string }>(
            "SELECT effective_contract_rent($1,'2028-11-15')::text AS rent",
            [id],
          )
        ).rows[0].rent,
        "21000",
      );
    },
  );
  await t.test(
    "signed financial terms cannot be rewritten or mandatory fees increased",
    async () => {
      const agreement = (
        await db.query<{ agreement_id: number }>(
          "SELECT agreement_id FROM contracts WHERE id=$1",
          [id],
        )
      ).rows[0].agreement_id;
      await assert.rejects(
        db.query("UPDATE terms SET service_charge=100 WHERE id=$1", [
          agreement,
        ]),
        /immutable/i,
      );
      await assert.rejects(
        db.query("UPDATE contracts SET start_date='2027-01-01' WHERE id=$1", [
          id,
        ]),
        /immutable/i,
      );
      await assert.rejects(proposed(db), /continuing|open contract/i);
    },
  );
  await t.test(
    "expiry alone cannot release a listing; renewal preserves original protection",
    async () => {
      await assert.rejects(
        db.query("UPDATE contracts SET status='completed' WHERE id=$1", [id]),
        /move.out|closure/i,
      );
      const renewal = await proposed(
        db,
        1,
        "20000",
        "2027-11-15",
        "2028-11-14",
        id,
      );
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        renewal,
      ]);
      assert.equal(
        (
          await db.query<{ date: string }>(
            "SELECT protection_until::text AS date FROM contracts WHERE id=$1",
            [renewal],
          )
        ).rows[0].date,
        "2028-11-15",
      );
      await assert.rejects(
        db.query("SELECT propose_rent_revision(1,$1,21000,'2028-11-14')", [
          renewal,
        ]),
        /24-month/,
      );
      assert.equal(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM listings WHERE id=1",
          )
        ).rows[0].status,
        "occupied",
      );
    },
  );
  await t.test(
    "leap-year anniversary uses calendar months and decrease retains baseline",
    async () => {
      const leap = await proposed(db, 2, "20000", "2028-02-29", "2029-02-28");
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        leap,
      ]);
      assert.equal(
        (
          await db.query<{ date: string }>(
            "SELECT protection_until::text AS date FROM contracts WHERE id=$1",
            [leap],
          )
        ).rows[0].date,
        "2030-02-28",
      );
      const revision = (
        await db.query<{ id: number }>(
          "SELECT propose_rent_revision(1,$1,19000,'2028-03-01') AS id",
          [leap],
        )
      ).rows[0].id;
      await db.query("SELECT accept_rent_revision(2,$1,true)", [revision]);
      await assert.rejects(
        db.query("SELECT propose_rent_revision(1,$1,19500,'2028-04-01')", [
          leap,
        ]),
        /24-month/,
      );
      assert.equal(
        (
          await db.query<{ rent: string }>(
            "SELECT initial_rent::text AS rent FROM contracts WHERE id=$1",
            [leap],
          )
        ).rows[0].rent,
        "20000",
      );
    },
  );
  await t.test(
    "proposal terms are frozen before signing, closing a concurrent edit bypass",
    async () => {
      const draft = await proposed(db, 3);
      const row = (
        await db.query<{ agreement_id: number }>(
          "SELECT agreement_id FROM contracts WHERE id=$1",
          [draft],
        )
      ).rows[0];
      await assert.rejects(
        db.query("UPDATE terms SET service_charge=90000 WHERE id=$1", [
          row.agreement_id,
        ]),
        /immutable/,
      );
    },
  );
  await t.test(
    "future renewal keeps billing the predecessor and existing proposals reviewable",
    async () => {
      const today = (
        await db.query<{ today: string }>(
          "SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today",
        )
      ).rows[0].today;
      const current = await proposed(
        db,
        4,
        "20000",
        "2026-01-01",
        "2026-12-31",
      );
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        current,
      ]);
      const revision = (
        await db.query<{ id: number }>(
          "SELECT propose_rent_revision(1,$1,19000,'2027-01-15') AS id",
          [current],
        )
      ).rows[0].id;
      const renewal = await proposed(
        db,
        4,
        "20000",
        "2027-01-01",
        "2027-12-31",
        current,
      );
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        renewal,
      ]);
      await db.exec("CALL generate_monthly_payments()");
      assert.equal(
        (
          await db.query(
            "SELECT id FROM payments WHERE contract_id=$1 AND billing_month=date_trunc('month',$2::date)::date",
            [current, today],
          )
        ).rows.length,
        1,
      );
      await db.query("SELECT accept_rent_revision(2,$1,true)", [revision]);
    },
  );
  await t.test(
    "accepted eligible revision bills exact new rent and preserves past invoices",
    async () => {
      await db.exec(
        "INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id) VALUES('Synthetic billing','Test',1,1,2,1,6,1,1)",
      );
      const dates = (
        await db.query<{ start: string; end: string; today: string }>(
          "SELECT ((now() AT TIME ZONE 'Asia/Dhaka')::date-interval '24 months')::date::text AS start,((now() AT TIME ZONE 'Asia/Dhaka')::date+400)::text AS end,(now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today",
        )
      ).rows[0];
      const c = await proposed(db, 6, "20000", dates.start, dates.end);
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [c]);
      await db.query(
        "INSERT INTO payments(contract_id,amount,billing_month) VALUES($1,20000,(date_trunc('month',$2::date)-interval '1 month')::date)",
        [c, dates.today],
      );
      const revision = (
        await db.query<{ id: number }>(
          "SELECT propose_rent_revision(1,$1,21000.15,$2) AS id",
          [c, dates.today],
        )
      ).rows[0].id;
      await db.query("SELECT accept_rent_revision(2,$1,true)", [revision]);
      await db.exec("CALL generate_monthly_payments()");
      assert.deepEqual(
        (
          await db.query(
            "SELECT amount::text FROM payments WHERE contract_id=$1 ORDER BY billing_month",
            [c],
          )
        ).rows,
        [{ amount: "20000" }, { amount: "21000.15" }],
      );
    },
  );
  await t.test(
    "ownership change preserves protection and revokes old landlord amendment access",
    async () => {
      const c = (
        await db.query<{ id: number }>(
          "SELECT id FROM contracts WHERE listing_id=2 AND status='signed'",
        )
      ).rows[0].id;
      await db.exec("UPDATE listings SET owner_id=3 WHERE id=2");
      await assert.rejects(
        db.query("SELECT propose_rent_revision(1,$1,19500,'2028-04-01')", [c]),
        /authorized/,
      );
      await assert.rejects(
        db.query("SELECT propose_rent_revision(3,$1,19500,'2028-04-01')", [c]),
        /24-month/,
      );
      assert.equal(
        (
          await db.query<{ rent: string }>(
            "SELECT initial_rent::text AS rent FROM contracts WHERE id=$1",
            [c],
          )
        ).rows[0].rent,
        "20000",
      );
    },
  );
});
