import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";

test("sandbox confirmation uses the existing ledger atomically and idempotently", async (t) => {
  const db = await rentalDatabase(true);
  t.after(() => db.close());
  for (const name of [
    "019_rental_payment_events.sql",
    "020_payment_sandbox.sql",
  ])
    await db.exec(
      await readFile(
        resolve(__dirname, "../../../db/migrations", name),
        "utf8",
      ),
    );
  const contract = await proposed(db);
  await db.query<any>("UPDATE contracts SET status='signed' WHERE id=$1", [
    contract,
  ]);
  await db.query<any>("INSERT INTO sandbox_contracts(contract_id) VALUES($1)", [
    contract,
  ]);
  const payment = (
    await db.query<{ id: number }>(
      "INSERT INTO payments(contract_id,amount) VALUES($1,100) RETURNING id",
      [contract],
    )
  ).rows[0].id;
  await db.query<any>(
    `INSERT INTO payment_attempts(id,payment_id,tenant_id,merchant_order_id,amount,provider_order_id,state)
    VALUES('a',$1,2,'merchant1',40,'sp1','pending')`,
    [payment],
  );
  const evidence = {
    order_id: "sp1",
    customer_order_id: "merchant1",
    amount: "40.0000",
    currency: "BDT",
    value1: String(payment),
    value2: "a",
    sp_code: "1000",
  };
  for (const patch of [
    { amount: "41" },
    { currency: "USD" },
    { order_id: "bad" },
    { customer_order_id: "bad" },
    { sp_code: "1002" },
    { value1: "999" },
  ])
    await assert.rejects(
      db.query<any>("SELECT confirm_sandbox_payment($1,$2::jsonb)", [
        "a",
        JSON.stringify({ ...evidence, ...patch }),
      ]),
    );
  await db.query<any>("SELECT confirm_sandbox_payment($1,$2::jsonb)", [
    "a",
    JSON.stringify(evidence),
  ]);
  await db.query<any>("SELECT confirm_sandbox_payment($1,$2::jsonb)", [
    "a",
    JSON.stringify(evidence),
  ]);
  assert.equal(
    (await db.query<any>("SELECT rental_outstanding($1)::text AS n", [payment]))
      .rows[0].n,
    "60",
  );
  assert.equal(
    (
      await db.query<any>(
        "SELECT sum(amount)::text AS n FROM rental_income_payments WHERE contract_id=$1",
        [contract],
      )
    ).rows[0].n,
    "40",
  );
  assert.equal(
    (
      await db.query<any>(
        "SELECT count(*)::int AS n FROM rental_documents WHERE kind='acknowledgment'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query<any>(
        "SELECT count(*)::int AS n FROM notifications WHERE event_key='sandbox:a'",
      )
    ).rows[0].n,
    2,
  );
  // Cash on the same partially paid obligation still works.
  const cash = (
    await db.query<any>(
      "SELECT claim_rental_payment(2,$1,60,'Cash','cash') AS id",
      [payment],
    )
  ).rows[0].id;
  await db.query<any>("SELECT confirm_rental_payment(1,$1)", [cash]);
  assert.equal(
    (await db.query<any>("SELECT rental_outstanding($1)::text AS n", [payment]))
      .rows[0].n,
    "0",
  );
  assert.equal(
    (
      await db.query<any>(
        "SELECT sum(amount)::text AS n FROM rental_income_payments WHERE contract_id=$1",
        [contract],
      )
    ).rows[0].n,
    "100",
  );
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query<any>(
          "SELECT has_table_privilege($1,'payment_attempts','SELECT') AS ok",
          [role],
        )
      ).rows[0].ok,
      false,
    );
    assert.equal(
      (
        await db.query<any>(
          "SELECT has_function_privilege($1,'confirm_sandbox_payment(text,jsonb)','EXECUTE') AS ok",
          [role],
        )
      ).rows[0].ok,
      false,
    );
  }
});
