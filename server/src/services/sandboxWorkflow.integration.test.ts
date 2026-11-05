import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";
import { bindSandboxDatabase } from "./testing/sandboxDatabase.js";
import {
  initiateSandbox,
  processOneSandboxAttempt,
  requestSandboxVerification,
  wakeSandboxCallback,
} from "./sandboxPayments.service.js";
import {
  completeSimulation,
  simulatedPaymentProvider,
} from "./simulatedPaymentProvider.js";
import {
  CheckoutNotSubmitted,
  type SandboxProvider,
} from "./shurjoPaySandbox.js";
import { processOneRentalDocument } from "./rentalDocuments.service.js";
import sandboxRouter from "../routes/sandboxPayment.route.js";
import rentalRouter from "../routes/rental.route.js";
import paymentRouter from "../routes/payment.route.js";

test("isolated simulated provider, HTTP authorization, durable worker and existing ledger", async (t) => {
  process.env.NODE_ENV = "test";
  process.env.PAYMENT_SANDBOX_ENABLED = "true";
  process.env.PAYMENT_SANDBOX_PROVIDER = "simulated";
  process.env.JWT_SECRET = "test-only-key";
  const db = await rentalDatabase(true);
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
  const unbind = bindSandboxDatabase(db);
  t.after(async () => {
    unbind();
    await db.close();
  });
  const contract = await proposed(db);
  await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
    contract,
  ]);
  await db.query("INSERT INTO sandbox_contracts(contract_id) VALUES($1)", [
    contract,
  ]);
  const invoice = async () =>
    String(
      (
        await db.query<{ id: number }>(
          "INSERT INTO payments(contract_id,amount) VALUES($1,100) RETURNING id",
          [contract],
        )
      ).rows[0].id,
    );
  const state = async (id: string) =>
    (await db.query<any>("SELECT * FROM payment_attempts WHERE id=$1", [id]))
      .rows[0];
  const balance = async (id: string) =>
    (await db.query<any>("SELECT rental_outstanding($1)::text AS value", [id]))
      .rows[0].value;
  const ready = async (id: string) => {
    await db.query(
      "UPDATE simulated_provider_transactions SET available_at=now()-interval '1 second' WHERE attempt_id=$1",
      [id],
    );
    await db.query("UPDATE payment_attempts SET retry_at=now() WHERE id=$1", [
      id,
    ]);
  };
  const app = express();
  app.use(express.json());
  app.use("/api/payment-sandbox", sandboxRouter);
  app.use("/api/rental", rentalRouter);
  app.use("/api/payments", paymentRouter);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const request = (
    actor: number,
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    fetch(base + "/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Bearer " +
          jwt.sign(
            { id: actor, email: "test@example.test" },
            process.env.JWT_SECRET!,
          ),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let successful = "";
  let successfulPayment = "";
  await t.test(
    "authorization, client amount injection and disabled configuration",
    async () => {
      const p = await invoice();
      assert.equal(
        (await request(3, "payment-sandbox/payments/" + p, "POST", {})).status,
        403,
      );
      assert.equal(
        (
          await request(2, "payment-sandbox/payments/" + p, "POST", {
            amount: "0.01",
          })
        ).status,
        400,
      );
      assert.equal(
        (await fetch(base + "/api/payment-sandbox/payments/" + p)).status,
        401,
      );
      process.env.PAYMENT_SANDBOX_ENABLED = "false";
      assert.equal(
        (await request(2, "payment-sandbox/payments/" + p)).status,
        404,
      );
      process.env.PAYMENT_SANDBOX_ENABLED = "true";
      const other = await proposed(db, 2);
      await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [
        other,
      ]);
      const q = (
        await db.query<any>(
          "INSERT INTO payments(contract_id,amount) VALUES($1,100) RETURNING id",
          [other],
        )
      ).rows[0].id;
      await assert.rejects(initiateSandbox(2, String(q)), /synthetic/);
    },
  );
  await t.test(
    "forged callback and redirect cannot confirm; duplicates use one attempt",
    async () => {
      const p = await invoice();
      successfulPayment = p;
      const attempts = await Promise.all([
        initiateSandbox(2, p),
        initiateSandbox(2, p),
      ]);
      assert.equal(attempts[0].id, attempts[1].id);
      successful = attempts[0].id;
      const a = await state(successful);
      for (let n = 0; n < 3; n++)
        assert.equal(
          (
            await request(
              0,
              "payment-sandbox/return?order_id=" + a.provider_order_id,
            )
          ).status,
          200,
        );
      await wakeSandboxCallback("forged-order");
      await processOneSandboxAttempt();
      assert.equal(await balance(p), "100");
      assert.equal((await state(successful)).state, "pending");
      assert.equal(
        (
          await request(
            3,
            `payment-sandbox/attempts/${successful}/verify`,
            "POST",
            {},
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            3,
            `payment-sandbox/attempts/${successful}/simulate`,
            "POST",
            { outcome: "succeeded" },
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "delayed success, repeated verification and concurrent worker leases settle exactly once",
    async () => {
      await completeSimulation(2, successful, "succeeded", 120);
      await requestSandboxVerification(2, successful);
      await processOneSandboxAttempt();
      assert.equal(await balance(successfulPayment), "100");
      await ready(successful);
      await Promise.all([
        processOneSandboxAttempt(),
        processOneSandboxAttempt(),
        processOneSandboxAttempt(),
      ]);
      assert.equal((await state(successful)).state, "succeeded");
      assert.equal(await balance(successfulPayment), "0");
      await Promise.all([
        requestSandboxVerification(2, successful),
        requestSandboxVerification(2, successful),
      ]);
      await processOneSandboxAttempt();
      assert.equal(
        (
          await db.query<any>(
            "SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1",
            [successfulPayment],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(initiateSandbox(2, successfulPayment), /payable/);
      await assert.rejects(
        completeSimulation(2, successful, "succeeded", 2),
        /already completed/,
      );
    },
  );
  await t.test(
    "failure and cancellation never create paid events",
    async () => {
      for (const outcome of ["failed", "cancelled"]) {
        const p = await invoice();
        const a = await initiateSandbox(2, p);
        await completeSimulation(2, a.id, outcome, 2);
        await ready(a.id);
        await processOneSandboxAttempt();
        assert.equal((await state(a.id)).state, outcome);
        assert.equal(await balance(p), "100");
        assert.equal(
          (
            await db.query<any>(
              "SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1",
              [p],
            )
          ).rows[0].n,
          0,
        );
      }
    },
  );
  await t.test(
    "partial cash payment plus online remainder reconciles income and balance",
    async () => {
      const p = await invoice();
      const e = (
        await db.query<any>(
          "SELECT claim_rental_payment(2,$1,30,'Cash','partial') AS id",
          [p],
        )
      ).rows[0].id;
      await assert.rejects(initiateSandbox(2, p), /pending manual/);
      await db.query("SELECT confirm_rental_payment(1,$1)", [e]);
      const a = await initiateSandbox(2, p);
      assert.equal((await state(a.id)).amount, "70");
      await completeSimulation(2, a.id, "succeeded", 2);
      await ready(a.id);
      await processOneSandboxAttempt();
      assert.equal(await balance(p), "0");
      assert.equal(
        (
          await db.query<any>(
            "SELECT sum(amount)::text AS total FROM rental_income_payments WHERE id=$1",
            [p],
          )
        ).rows[0].total,
        "100",
      );
    },
  );
  await t.test(
    "amount/currency mismatch quarantined; timeout remains unconfirmed; expiry requires review",
    async () => {
      for (const patch of [{ amount: "101" }, { currency: "USD" }]) {
        const p = await invoice();
        const a = await initiateSandbox(2, p);
        await ready(a.id);
        await processOneSandboxAttempt({
          ...simulatedPaymentProvider,
          verify: async (order) => ({
            ...(await simulatedPaymentProvider.verify(order)),
            ...patch,
            sp_code: "1000",
          }),
        });
        assert.equal((await state(a.id)).state, "review");
        assert.equal(await balance(p), "100");
      }
      const p = await invoice();
      const a = await initiateSandbox(2, p);
      await ready(a.id);
      await processOneSandboxAttempt({
        ...simulatedPaymentProvider,
        verify: async () => {
          throw new Error("timeout");
        },
      });
      assert.equal((await state(a.id)).state, "pending");
      assert.equal(await balance(p), "100");
      await db.query(
        "UPDATE payment_attempts SET expires_at=now()-interval '1 second',retry_at=now() WHERE id=$1",
        [a.id],
      );
      await processOneSandboxAttempt();
      assert.equal((await state(a.id)).state, "review");
    },
  );
  await t.test("changed outstanding cannot be overcredited", async () => {
    const p = await invoice();
    const a = await initiateSandbox(2, p);
    const e = (
      await db.query<any>(
        "SELECT claim_rental_payment(2,$1,20,'Cash','race') AS id",
        [p],
      )
    ).rows[0].id;
    await db.query("SELECT confirm_rental_payment(1,$1)", [e]);
    await completeSimulation(2, a.id, "succeeded", 2);
    await ready(a.id);
    await processOneSandboxAttempt();
    assert.equal((await state(a.id)).state, "review");
    assert.equal(await balance(p), "80");
  });
  await t.test(
    "preflight failure is retryable; uncertain submission is not charged again",
    async () => {
      const p = await invoice();
      const preflight: SandboxProvider = {
        ...simulatedPaymentProvider,
        initiate: async () => {
          throw new CheckoutNotSubmitted("bad config");
        },
      };
      const a = await initiateSandbox(2, p, preflight);
      assert.equal((await state(a.id)).state, "failed");
      const next = await initiateSandbox(2, p, {
        ...simulatedPaymentProvider,
        initiate: async () => {
          throw new Error("lost response");
        },
      });
      assert.notEqual(a.id, next.id);
      assert.equal((await state(next.id)).state, "review");
      assert.equal((await initiateSandbox(2, p)).id, next.id);
    },
  );
  await t.test(
    "expired worker lease recovers durable pending attempt",
    async () => {
      const p = await invoice();
      const a = await initiateSandbox(2, p);
      await completeSimulation(2, a.id, "succeeded", 2);
      await ready(a.id);
      await db.query(
        "UPDATE payment_attempts SET lease_until=now()-interval '1 second',lease_token='dead-process' WHERE id=$1",
        [a.id],
      );
      await processOneSandboxAttempt();
      assert.equal((await state(a.id)).state, "succeeded");
    },
  );
  await t.test("hosted demo exposes checkout and enrolls only the requesting tenant's contract", async (t) => {
    const previousDemo = process.env.NIBASH_DEMO_MODE;
    process.env.NIBASH_DEMO_MODE = "true";
    process.env.NODE_ENV = "production";
    t.after(() => {
      process.env.NODE_ENV = "test";
      if (previousDemo === undefined) delete process.env.NIBASH_DEMO_MODE;
      else process.env.NIBASH_DEMO_MODE = previousDemo;
    });
    const demoContract = await proposed(db, 3);
    await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [demoContract]);
    const p = String((await db.query<{ id: number }>(
      "INSERT INTO payments(contract_id,amount) VALUES($1,100) RETURNING id", [demoContract],
    )).rows[0].id);
    const enrolled = async () => (await db.query(
      "SELECT 1 FROM sandbox_contracts WHERE contract_id=$1", [demoContract],
    )).rows.length;
    const details = await request(2, `rental/contracts/${demoContract}`);
    assert.equal(details.status, 200);
    const data = await details.json();
    assert.equal(data.payment_sandbox, true);
    assert.equal(data.payment_sandbox_provider, "simulated");
    for (const actor of [1, 2]) {
      const list = await request(actor, `payment-sandbox/payments/${p}`);
      assert.equal(list.status, 200);
      assert.deepEqual((await list.json()).attempts, []);
    }
    assert.equal((await request(3, `payment-sandbox/payments/${p}`)).status, 403);
    for (const actor of [1, 3])
      assert.equal((await request(actor, `payment-sandbox/payments/${p}`, "POST", {})).status, 403);
    assert.equal(await enrolled(), 0);
    const started = await request(2, `payment-sandbox/payments/${p}`, "POST", {});
    assert.equal(started.status, 202);
    const attempt = await started.json();
    assert.equal(await enrolled(), 1);
    await completeSimulation(2, attempt.id, "succeeded", 2);
    await ready(attempt.id);
    for (let n = 0; n < 20 && (await state(attempt.id)).state === "pending"; n++)
      await processOneSandboxAttempt();
    assert.equal((await state(attempt.id)).state, "succeeded");
    assert.equal(await balance(p), "0");
    const event = (await db.query<{ method: string }>(
      "SELECT method FROM payment_events WHERE payment_id=$1", [p],
    )).rows[0];
    assert.equal(event.method, "Simulated TEST");
  });
  await t.test(
    "receipt failure recovers without changing confirmed money and unrelated owners cannot download",
    async () => {
      while (await processOneRentalDocument()) {}
      const p = await invoice();
      const a = await initiateSandbox(2, p);
      await completeSimulation(2, a.id, "succeeded", 2);
      await ready(a.id);
      await processOneSandboxAttempt();
      await processOneRentalDocument(async () => {
        throw new Error("synthetic renderer outage");
      });
      const doc = (
        await db.query<any>(
          "SELECT d.id,d.state FROM rental_documents d JOIN payment_attempts a ON a.event_id=d.event_id WHERE a.id=$1",
          [a.id],
        )
      ).rows[0];
      assert.equal(doc.state, "queued");
      assert.equal(await balance(p), "0");
      assert.equal(
        (await request(3, `rental/documents/${doc.id}/download`)).status,
        403,
      );
      assert.equal(
        (await request(2, `rental/documents/${doc.id}/download`)).status,
        202,
      );
      await db.query("UPDATE rental_documents SET retry_at=now() WHERE id=$1", [
        doc.id,
      ]);
      await processOneRentalDocument();
      const pdf = await request(2, `rental/documents/${doc.id}/download`);
      assert.equal(pdf.status, 200);
      assert.match(pdf.headers.get("content-type")!, /pdf/);
      assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
    },
  );
});
