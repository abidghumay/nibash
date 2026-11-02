import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";

test("confirmed installments create durable immutable acknowledgments", async (t) => {
  const db = await rentalDatabase(true);
  t.after(() => db.close());
  await db.exec(
    await readFile(
      resolve(
        __dirname,
        "../../../db/migrations/019_rental_payment_events.sql",
      ),
      "utf8",
    ),
  );
  const contract = await proposed(db);
  await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
    contract,
  ]);
  const payment = (
    await db.query<{ id: number }>(
      "INSERT INTO payments(contract_id,amount) VALUES($1,20000) RETURNING id",
      [contract],
    )
  ).rows[0].id;
  await t.test(
    "Supabase browser roles cannot read financial records or execute privileged functions",
    async () => {
      for (const role of ["anon", "authenticated"]) {
        for (const relation of [
          "contracts",
          "terms",
          "agreements",
          "payments",
          "rental_documents",
          "rental_audit_events",
          "rent_revisions",
          "payment_events",
          "payment_reversals",
          "advance_allocations",
          "dmp_preparation",
          "rental_income_payments",
        ])
          assert.equal(
            (
              await db.query<{ allowed: boolean }>(
                "SELECT has_table_privilege($1,$2,'SELECT') AS allowed",
                [role, relation],
              )
            ).rows[0].allowed,
            false,
            relation,
          );
        for (const signature of [
          "confirm_rental_payment(integer,bigint)",
          "propose_rent_revision(integer,integer,numeric,date)",
          "rental_contract_snapshot(integer)",
          "allocate_contract_advance(integer)",
        ])
          assert.equal(
            (
              await db.query<{ allowed: boolean }>(
                "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
                [role, signature],
              )
            ).rows[0].allowed,
            false,
            signature,
          );
      }
    },
  );
  let event = 0;
  await t.test(
    "cash claim remains pending without receipt; amount must be exact and within outstanding",
    async () => {
      await assert.rejects(
        db.query("SELECT claim_rental_payment(3,$1,5000,'Cash','other')", [
          payment,
        ]),
        /authorized/,
      );
      await assert.rejects(
        db.query("SELECT claim_rental_payment(2,$1,20001,'Cash','excess')", [
          payment,
        ]),
        /outstanding/,
      );
      event = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,5000,'Cash','first') AS id",
          [payment],
        )
      ).rows[0].id;
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE kind='acknowledgment'",
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await db.query<{ id: number }>(
            "SELECT claim_rental_payment(2,$1,5000,'Cash','first') AS id",
            [payment],
          )
        ).rows[0].id,
        event,
      );
    },
  );
  await t.test(
    "owner confirmation is idempotent and snapshots actual received amount and balance",
    async () => {
      await assert.rejects(
        db.query("SELECT confirm_rental_payment(3,$1)", [event]),
        /authorized/,
      );
      await db.query("SELECT confirm_rental_payment(1,$1)", [event]);
      await db.query("SELECT confirm_rental_payment(1,$1)", [event]);
      const docs = await db.query<{
        snapshot: { amount_received: string; outstanding_balance: string };
      }>("SELECT snapshot FROM rental_documents WHERE kind='acknowledgment'");
      assert.equal(docs.rows.length, 1);
      assert.equal(docs.rows[0].snapshot.amount_received, "5000");
      assert.equal(docs.rows[0].snapshot.outstanding_balance, "15000");
      assert.equal(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM payments WHERE id=$1",
            [payment],
          )
        ).rows[0].status,
        "pending",
      );
      assert.equal(
        (
          await db.query<{ total: string }>(
            "SELECT sum(amount)::text AS total FROM rental_income_payments",
          )
        ).rows[0].total,
        "5000",
      );
    },
  );
  await t.test(
    "multiple installments generate distinct receipts and settle invoice only when fully received",
    async () => {
      const e2 = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,15000,'Cash','second') AS id",
          [payment],
        )
      ).rows[0].id;
      await db.query("SELECT confirm_rental_payment(1,$1)", [e2]);
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE kind='acknowledgment'",
          )
        ).rows.length,
        2,
      );
      assert.equal(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM payments WHERE id=$1",
            [payment],
          )
        ).rows[0].status,
        "confirmed",
      );
      assert.equal(
        (
          await db.query<{ total: string }>(
            "SELECT sum(amount)::text AS total FROM rental_income_payments",
          )
        ).rows[0].total,
        "20000",
      );
      await assert.rejects(
        db.query("UPDATE payment_events SET amount=1 WHERE id=$1", [event]),
        /immutable/,
      );
      await assert.rejects(
        db.query("UPDATE payments SET amount=1 WHERE id=$1", [payment]),
        /immutable/,
      );
    },
  );
  await t.test(
    "reversal preserves original acknowledgment and adds linked correction",
    async () => {
      await db.query(
        "SELECT reverse_rental_payment(1,$1,'Synthetic correction test')",
        [event],
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE kind='acknowledgment'",
          )
        ).rows.length,
        2,
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE kind='reversal'",
          )
        ).rows.length,
        1,
      );
      assert.equal(
        (
          await db.query<{ total: string }>(
            "SELECT sum(amount)::text AS total FROM rental_income_payments",
          )
        ).rows[0].total,
        "15000",
      );
      await assert.rejects(
        db.query("DELETE FROM rental_documents WHERE kind='acknowledgment'"),
        /retained/,
      );
    },
  );
  await t.test(
    "document work survives expired leases and snapshots cannot change",
    async () => {
      await db.exec(
        "UPDATE rental_documents SET state='running',lease_token='dead-worker',lease_until=now()-interval '1 second' WHERE kind='acknowledgment'",
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM rental_documents WHERE state='running' AND lease_until<now()",
          )
        ).rows.length,
        2,
      );
      await assert.rejects(
        db.exec("UPDATE rental_documents SET snapshot='{}'"),
        /immutable/,
      );
    },
  );
  await t.test(
    "historical confirmed invoices cannot be downgraded, altered or deleted",
    async () => {
      const old = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount,status) VALUES($1,500,'confirmed') RETURNING id",
          [contract],
        )
      ).rows[0].id;
      await assert.rejects(
        db.query("UPDATE payments SET status='pending' WHERE id=$1", [old]),
        /immutable/,
      );
      await assert.rejects(
        db.query("DELETE FROM payments WHERE id=$1", [old]),
        /retained|immutable/,
      );
    },
  );
  await t.test(
    "confirmed advance credits a rent obligation without double-counting cash income",
    async () => {
      const c = await proposed(db, 2, "10000", "2026-11-03", "2027-11-02");
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [c]);
      const advance = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount,category) VALUES($1,10000,'advance') RETURNING id",
          [c],
        )
      ).rows[0].id;
      const claim = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,10000,'Cash','advance-test') AS id",
          [advance],
        )
      ).rows[0].id;
      await db.query("SELECT confirm_rental_payment(1,$1)", [claim]);
      const rent = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount,category) VALUES($1,10000,'rent') RETURNING id",
          [c],
        )
      ).rows[0].id;
      assert.equal(
        (
          await db.query<{ balance: string }>(
            "SELECT rental_outstanding($1)::text AS balance",
            [rent],
          )
        ).rows[0].balance,
        "0",
      );
      assert.equal(
        (
          await db.query<{ total: string }>(
            "SELECT sum(amount)::text AS total FROM rental_income_payments WHERE contract_id=$1",
            [c],
          )
        ).rows[0].total,
        "10000",
      );
      await db.query(
        "SELECT reverse_rental_payment(1,$1,'Advance returned to tenant')",
        [claim],
      );
      assert.equal(
        (
          await db.query<{ balance: string }>(
            "SELECT rental_outstanding($1)::text AS balance",
            [rent],
          )
        ).rows[0].balance,
        "10000",
      );
    },
  );
  await t.test(
    "unused advance can re-credit an invoice after its cash installment is reversed",
    async () => {
      const c = await proposed(db, 3);
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [c]);
      const invoice = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount) VALUES($1,20000) RETURNING id",
          [c],
        )
      ).rows[0].id;
      const cash = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,10000,'Cash','cash-before-advance') AS id",
          [invoice],
        )
      ).rows[0].id;
      await db.query("SELECT confirm_rental_payment(1,$1)", [cash]);
      const advance = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount,category) VALUES($1,20000,'advance') RETURNING id",
          [c],
        )
      ).rows[0].id;
      const advanceEvent = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,20000,'Cash','advance-after-cash') AS id",
          [advance],
        )
      ).rows[0].id;
      await db.query("SELECT confirm_rental_payment(1,$1)", [advanceEvent]);
      await db.query(
        "SELECT reverse_rental_payment(1,$1,'Cash installment returned')",
        [cash],
      );
      await db.query(
        "INSERT INTO payments(contract_id,amount) VALUES($1,20000)",
        [c],
      );
      assert.equal(
        (
          await db.query<{ balance: string }>(
            "SELECT rental_outstanding($1)::text AS balance",
            [invoice],
          )
        ).rows[0].balance,
        "0",
      );
    },
  );
  await t.test(
    "advance credit never strands an already pending cash claim",
    async () => {
      const c = await proposed(db, 4);
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [c]);
      const invoice = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount) VALUES($1,20000) RETURNING id",
          [c],
        )
      ).rows[0].id;
      const cash = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,20000,'Cash','pending-cash') AS id",
          [invoice],
        )
      ).rows[0].id;
      const advance = (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount,category) VALUES($1,20000,'advance') RETURNING id",
          [c],
        )
      ).rows[0].id;
      const advanceEvent = (
        await db.query<{ id: number }>(
          "SELECT claim_rental_payment(2,$1,20000,'Cash','advance-with-pending-cash') AS id",
          [advance],
        )
      ).rows[0].id;
      await db.query("SELECT confirm_rental_payment(1,$1)", [advanceEvent]);
      assert.equal(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM payments WHERE id=$1",
            [invoice],
          )
        ).rows[0].status,
        "pending",
      );
      await db.query("SELECT confirm_rental_payment(1,$1)", [cash]);
    },
  );
  await t.test(
    "midmonth continuing renewal never creates a second full invoice for the same month",
    async () => {
      await db.exec(
        "INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id) VALUES('Synthetic renewal','Test',1,1,2,1,6,1,1)",
      );
      const date = (
        await db.query<{ today: string; yesterday: string; end: string }>(
          "SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today,((now() AT TIME ZONE 'Asia/Dhaka')::date-1)::text AS yesterday,((now() AT TIME ZONE 'Asia/Dhaka')::date+365)::text AS end",
        )
      ).rows[0];
      const prior = await proposed(
        db,
        6,
        "20000",
        "2026-01-01",
        date.yesterday,
      );
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        prior,
      ]);
      await db.query(
        "INSERT INTO payments(contract_id,amount,billing_month) VALUES($1,20000,date_trunc('month',$2::date)::date)",
        [prior, date.today],
      );
      const renewal = await proposed(
        db,
        6,
        "20000",
        date.today,
        date.end,
        prior,
      );
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        renewal,
      ]);
      await db.exec("CALL generate_monthly_payments()");
      assert.equal(
        (
          await db.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM payments WHERE contract_id IN ($1,$2) AND billing_month=date_trunc('month',$3::date)::date",
            [prior, renewal, date.today],
          )
        ).rows[0].count,
        1,
      );
    },
  );
});
