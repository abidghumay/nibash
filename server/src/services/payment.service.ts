import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import type { CreatePaymentInput } from "../schemas/payment.schema.js";

export async function createPayment(
  tenantId: number,
  data: CreatePaymentInput,
) {
  // Reuse an issued invoice; clients cannot invent obligations or alter historic amounts.
  const due = await pool.query(
    `SELECT p.id FROM payments p JOIN contracts c ON c.id=p.contract_id
    WHERE c.id=$1 AND c.tenant_id=$2 AND p.status IN ('pending','overdue') ORDER BY p.due_date NULLS LAST,p.id LIMIT 1`,
    [data.contract_id, tenantId],
  );
  if (!due.rows.length)
    throw new AppError(400, "No outstanding invoice is available");
  await pool.query("SELECT claim_rental_payment($1,$2,$3,$4,$5)", [
    tenantId,
    due.rows[0].id,
    String(data.amount),
    data.payment_method,
    randomUUID(),
  ]);
}
export async function getPaymentsForContract(
  userId: number,
  contractId: string,
) {
  const allowed = await pool.query(
    `SELECT 1 FROM contracts c JOIN listings l ON l.id=c.listing_id
    WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2)`,
    [contractId, userId],
  );
  if (!allowed.rows.length)
    throw new AppError(403, "Not authorized for this contract");
  return (
    await pool.query(
      `SELECT p.id,p.contract_id,p.amount,p.category,p.payment_method,p.status,p.billing_month,p.due_date,p.paid_at,
    CASE WHEN p.status='confirmed' AND NOT EXISTS(SELECT 1 FROM payment_events e WHERE e.payment_id=p.id) AND NOT EXISTS(SELECT 1 FROM advance_allocations a WHERE a.rent_payment_id=p.id) THEN p.amount ELSE rental_received(p.id) END AS confirmed_amount,
    rental_credited(p.id) AS advance_credit,rental_outstanding(p.id) AS outstanding_balance
    FROM payments p WHERE p.contract_id IN (SELECT sibling.id FROM contracts sibling WHERE coalesce(sibling.root_contract_id,sibling.id)=(SELECT coalesce(root_contract_id,id) FROM contracts WHERE id=$1)) ORDER BY billing_month ASC NULLS LAST,due_date ASC NULLS LAST,p.id`,
      [contractId],
    )
  ).rows;
}
export async function payByCash(
  tenantId: number,
  paymentId: string,
  amount?: string,
  requestKey?: string,
) {
  const pending = await pool.query(
    `SELECT rental_outstanding(p.id) AS remaining,e.id,e.amount AS claim_amount,e.request_key
    FROM payments p JOIN contracts c ON c.id=p.contract_id
    LEFT JOIN payment_events e ON e.payment_id=p.id AND e.status='pending' WHERE p.id=$1 AND c.tenant_id=$2`,
    [paymentId, tenantId],
  );
  if (!pending.rows.length)
    throw new AppError(403, "Not authorized for this payment");
  const row = pending.rows[0];
  if (requestKey) {
    const existing = await pool.query(
      "SELECT amount,method FROM payment_events WHERE payment_id=$1 AND request_key=$2",
      [paymentId, requestKey],
    );
    if (existing.rows.length) {
      await pool.query("SELECT claim_rental_payment($1,$2,$3,'Cash',$4)", [
        tenantId,
        paymentId,
        amount ?? existing.rows[0].amount,
        requestKey,
      ]);
      return;
    }
  }
  if (row.id && !amount && !requestKey) return;
  await pool.query("SELECT claim_rental_payment($1,$2,$3,'Cash',$4)", [
    tenantId,
    paymentId,
    amount ?? row.remaining,
    requestKey ?? randomUUID(),
  ]);
}
export async function rejectCash(ownerId: number, paymentId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const allowed = await client.query(
      `SELECT p.id FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN listings l ON l.id=c.listing_id
      WHERE p.id=$1 AND l.owner_id=$2 AND p.status IN ('pending','overdue') FOR UPDATE OF p`,
      [paymentId, ownerId],
    );
    if (!allowed.rows.length)
      throw new AppError(403, "Not authorized for this pending payment");
    await client.query(
      "UPDATE payment_events SET status='rejected' WHERE payment_id=$1 AND status='pending'",
      [paymentId],
    );
    await client.query("UPDATE payments SET payment_method=NULL WHERE id=$1", [
      paymentId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function resolvePayment(
  ownerId: number,
  paymentId: string,
  status: string,
) {
  if (status === "failed") return rejectCash(ownerId, paymentId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT root.id FROM contracts root JOIN contracts c ON coalesce(c.root_contract_id,c.id)=root.id JOIN payments p ON p.contract_id=c.id WHERE p.id=$1 FOR UPDATE OF root",
      [paymentId],
    );
    const found = await client.query(
      `SELECT p.id,p.status,p.contract_id,c.tenant_id,p.payment_method,rental_outstanding(p.id) AS remaining
      FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN listings l ON l.id=c.listing_id
      WHERE p.id=$1 AND l.owner_id=$2 FOR UPDATE OF p`,
      [paymentId, ownerId],
    );
    if (!found.rows.length)
      throw new AppError(403, "Not authorized for this payment");
    const p = found.rows[0];
    const pending = await client.query(
      "SELECT id,amount FROM payment_events WHERE payment_id=$1 AND status='pending'",
      [paymentId],
    );
    if (
      pending.rows.length &&
      ((
        await client.query(
          "SELECT 1 FROM payment_events WHERE payment_id=$1 AND status='confirmed' LIMIT 1",
          [paymentId],
        )
      ).rows.length ||
        String(pending.rows[0].amount) !== String(p.remaining))
    )
      throw new AppError(
        400,
        "Confirm this installment by its event identifier in Rental management to avoid acknowledging a later claim on retry",
      );
    if (!pending.rows.length) {
      // A retry of a fully acknowledged invoice succeeds without issuing another receipt.
      if (p.status === "confirmed") {
        await client.query("COMMIT");
        return;
      }
      if (
        (
          await client.query(
            "SELECT 1 FROM payment_events WHERE payment_id=$1 AND status='confirmed' LIMIT 1",
            [paymentId],
          )
        ).rows.length
      ) {
        await client.query("COMMIT");
        return;
      }
      // Legacy Cash claims predate payment_events. Explicit owner confirmation converts only that claim.
      if (p.payment_method !== "Cash")
        throw new AppError(
          400,
          "A tenant payment claim with a recorded method is required before confirmation",
        );
      const legacy = await client.query(
        "INSERT INTO payment_events(payment_id,amount,method,claimed_by,request_key) VALUES($1,$2,'Cash',$3,$4) RETURNING id",
        [paymentId, p.remaining, p.tenant_id, "legacy-cash:" + paymentId],
      );
      pending.rows.push(legacy.rows[0]);
    }
    await client.query("SELECT confirm_rental_payment($1,$2)", [
      ownerId,
      pending.rows[0].id,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
