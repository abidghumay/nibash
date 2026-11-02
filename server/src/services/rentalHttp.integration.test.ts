import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { rentalDatabase } from "./testing/rentalFixtures.js";
import { pool } from "../db/pool.js";
import rentalRouter from "../routes/rental.route.js";
import contractRouter from "../routes/contract.route.js";
import paymentRouter from "../routes/payment.route.js";
import { processOneRentalDocument } from "./rentalDocuments.service.js";

test("synthetic authorized agreement, installment, PDF and My Tenants HTTP flow", async (t) => {
  const db = await rentalDatabase();
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
  const query = async (sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  const originalQuery = pool.query,
    originalConnect = pool.connect;
  pool.query = query as typeof pool.query;
  pool.connect = (async () => ({
    query,
    release() {},
  })) as unknown as typeof pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });
  process.env.JWT_SECRET = "synthetic-test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/rental", rentalRouter);
  app.use("/api/contracts", contractRouter);
  app.use("/api/payments", paymentRouter);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  async function request(
    actor: number,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        Authorization:
          "Bearer " +
          jwt.sign(
            { id: actor, email: "synthetic@example.test" },
            process.env.JWT_SECRET!,
          ),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  await db.exec("INSERT INTO applies(tenant_id,listing_id) VALUES(2,1)");
  const proposal = {
    listing_id: 1,
    tenant_id: 2,
    start_date: "2026-11-15",
    end_date: "2027-11-14",
    rent: "20000",
    electricity_bill: "0",
    water_bill: "0",
    service_charge: "0",
    monthly_due_date: 5,
    pet_allowed: false,
    security_deposit: "0",
    advance_rent: "20000",
  };
  const bad = await request(1, "/api/contracts", "POST", {
    ...proposal,
    security_deposit: "1000",
  });
  assert.equal(bad.status, 400);
  const excess = await request(1, "/api/contracts", "POST", {
    ...proposal,
    advance_rent: "40000",
  });
  assert.equal(excess.status, 400);
  assert.equal(
    (
      await request(1, "/api/contracts", "POST", {
        ...proposal,
        mandatory_deposit: "1000",
      })
    ).status,
    400,
  );
  const created = await request(1, "/api/contracts", "POST", proposal);
  assert.equal(created.status, 201, await created.clone().text());
  const id = ((await created.json()) as { contractId: number }).contractId;
  assert.equal((await request(3, `/api/rental/contracts/${id}`)).status, 403);
  assert.equal(
    (await request(2, `/api/contracts/${id}`, "PATCH", { status: "signed" }))
      .status,
    200,
  );
  assert.equal(
    (
      await request(1, `/api/rental/contracts/${id}/revisions`, "POST", {
        rent: "21000",
        effective_on: "2027-11-15",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(1, `/api/rental/contracts/${id}/revisions`, "POST", {
        rent: "19000",
        effective_on: "2027-11-15",
        service_charge: "1000",
      })
    ).status,
    400,
  );
  const own = await request(1, "/api/rental/tenants");
  assert.equal(own.status, 200);
  const privateData = await own.text();
  assert.ok(!privateData.includes("PRIVATE-NID-2"));
  assert.ok(!privateData.includes("password_hash"));
  assert.ok(!privateData.includes("nid"));
  assert.equal((await request(3, "/api/rental/tenants")).status, 200);
  const payment = (
    await db.query<{ id: number }>(
      "SELECT id FROM payments WHERE contract_id=$1 AND category='advance'",
      [id],
    )
  ).rows[0].id;
  assert.equal(
    (
      await request(2, `/api/payments/${payment}/pay-cash`, "PATCH", {
        amount: "5000",
        request_key: "http-synthetic-first",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM rental_documents WHERE kind='acknowledgment'",
      )
    ).rows.length,
    0,
  );
  const claimed = (
    await db.query<{ id: string }>(
      "SELECT id FROM payment_events WHERE payment_id=$1",
      [payment],
    )
  ).rows[0].id;
  assert.equal(
    (await request(1, `/api/rental/events/${claimed}/confirm`, "POST", {}))
      .status,
    200,
  );
  assert.equal(
    (
      await request(2, `/api/payments/${payment}/pay-cash`, "PATCH", {
        request_key: "http-synthetic-first",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(1, `/api/rental/events/${claimed}/confirm`, "POST", {}))
      .status,
    200,
  );
  assert.equal(
    (
      await request(2, `/api/payments/${payment}/pay-cash`, "PATCH", {
        amount: "5000",
        request_key: "http-synthetic-second",
      })
    ).status,
    200,
  );
  // An ambiguous retry through the old invoice endpoint must not acknowledge the next installment.
  assert.equal(
    (
      await request(1, `/api/payments/${payment}`, "PATCH", {
        status: "confirmed",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(1, `/api/payments/${payment}/reject-cash`, "PATCH", {}))
      .status,
    200,
  );
  const docs = await db.query<{ id: string; kind: string }>(
    "SELECT id,kind FROM rental_documents WHERE contract_id=$1 AND kind IN ('agreement','acknowledgment')",
    [id],
  );
  assert.equal(docs.rows.length, 2);
  // Simulate worker failure, then restart with an expired lease. A real PDF is generated from retained snapshots.
  await db.exec(
    "UPDATE rental_documents SET state='running',lease_token='lost-process',lease_until=now()-interval '1 second'",
  );
  await processOneRentalDocument(async () => {
    throw new Error("synthetic renderer failure");
  });
  assert.equal(
    (
      await db.query(
        "SELECT id FROM rental_documents WHERE state='queued' AND attempts>0",
      )
    ).rows.length,
    1,
  );
  await db.exec(
    "UPDATE rental_documents SET retry_at=now() WHERE state='queued'",
  );
  while (await processOneRentalDocument()) {}
  for (const doc of docs.rows) {
    assert.equal(
      (await request(3, `/api/rental/documents/${doc.id}/download`)).status,
      403,
    );
    for (const actor of [1, 2]) {
      const response = await request(
        actor,
        `/api/rental/documents/${doc.id}/download`,
      );
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.equal(
        response.headers.get("x-document-sha256"),
        createHash("sha256").update(bytes).digest("hex"),
      );
      if (actor === 1 && process.env.NIBASH_DEMO_OUTPUT) {
        await mkdir(process.env.NIBASH_DEMO_OUTPUT, { recursive: true });
        await writeFile(
          resolve(process.env.NIBASH_DEMO_OUTPUT, `synthetic-${doc.kind}.pdf`),
          bytes,
        );
      }
    }
  }
  const dmp = await request(1, `/api/rental/contracts/${id}/dmp`, "PATCH", {
    status: "submitted_manually_unverified",
    submission_date: "2026-11-03",
    self_reported_reference: "Synthetic manual reference",
  });
  assert.equal(dmp.status, 200);
  assert.equal(
    (
      await request(3, `/api/rental/contracts/${id}/dmp`, "PATCH", {
        status: "prepared",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(1, `/api/rental/contracts/${id}/dmp`, "PATCH", {
        status: "police_verified",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(2, `/api/rental/contracts/${id}/correction`, "POST", {
        message: "Please correct my synthetic contact details",
      })
    ).status,
    201,
  );
  const managed = await request(2, `/api/rental/contracts/${id}`);
  assert.equal(managed.status, 200);
  assert.ok(!(await managed.text()).includes("PRIVATE-NID-2"));
  // Closing a genuinely occupied synthetic rental requires reviewable matching confirmations.
  for (const firstActor of [1, 2]) {
    const listing = firstActor === 1 ? 2 : 3;
    await db.query("INSERT INTO applies(tenant_id,listing_id) VALUES(2,$1)", [
      listing,
    ]);
    const today = (
      await db.query<{ today: string }>(
        "SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today",
      )
    ).rows[0].today;
    const response = await request(1, "/api/contracts", "POST", {
      ...proposal,
      listing_id: listing,
      start_date: "2026-01-01",
      end_date: "2027-01-01",
      advance_rent: "0",
    });
    assert.equal(response.status, 201);
    const cid = ((await response.json()) as { contractId: number }).contractId;
    await request(2, `/api/contracts/${cid}`, "PATCH", { status: "signed" });
    const closure = {
      move_out_date: today,
      inspection_note: "Synthetic inspection completed",
      settlement_note: "Synthetic balance recorded and reviewed",
    };
    assert.equal(
      (
        await request(
          firstActor,
          `/api/rental/contracts/${cid}/close`,
          "POST",
          closure,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM listings WHERE id=$1",
          [listing],
        )
      ).rows[0].status,
      "occupied",
    );
    const secondActor = firstActor === 1 ? 2 : 1;
    const detail = await request(secondActor, `/api/rental/contracts/${cid}`);
    const body = (await detail.json()) as {
      contract: { inspection_note: string };
    };
    assert.equal(body.contract.inspection_note, closure.inspection_note);
    assert.equal(
      (
        await request(
          secondActor,
          `/api/rental/contracts/${cid}/close`,
          "POST",
          closure,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query<{ status: string }>(
          "SELECT status FROM listings WHERE id=$1",
          [listing],
        )
      ).rows[0].status,
      "approved",
    );
    await db.query(
      "UPDATE applies SET status='pending' WHERE tenant_id=2 AND listing_id=$1",
      [listing],
    );
    const fresh = await request(1, "/api/contracts", "POST", {
      ...proposal,
      listing_id: listing,
      start_date: today,
      end_date: "2027-12-31",
      rent: "22000",
      advance_rent: "0",
    });
    assert.equal(fresh.status, 201);
    const freshId = ((await fresh.json()) as { contractId: number }).contractId;
    await request(2, `/api/contracts/${freshId}`, "PATCH", {
      status: "signed",
    });
    assert.equal(
      (
        await db.query<{ rent: string }>(
          "SELECT initial_rent::text AS rent FROM contracts WHERE id=$1",
          [freshId],
        )
      ).rows[0].rent,
      "22000",
    );
  }
});
