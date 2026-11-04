import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import {
  CheckoutNotSubmitted,
  minorUnits,
  sandboxConfig,
  shurjoPaySandbox,
  validateVerification,
  type SandboxProvider,
} from "./shurjoPaySandbox.js";
import { simulatedPaymentProvider } from "./simulatedPaymentProvider.js";
const configuredProvider = () =>
  sandboxConfig().provider === "simulated"
    ? simulatedPaymentProvider
    : shurjoPaySandbox;

export function requireSandbox() {
  if (!sandboxConfig().enabled)
    throw new AppError(404, "Sandbox payments are disabled");
}
export async function listSandboxAttempts(userId: number, paymentId: string) {
  requireSandbox();
  const allowed = await pool.query(
    `SELECT p.id FROM payments p JOIN contracts c ON c.id=p.contract_id
    JOIN listings l ON l.id=c.listing_id JOIN sandbox_contracts s ON s.contract_id=c.id
    WHERE p.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2)`,
    [paymentId, userId],
  );
  if (!allowed.rows.length)
    throw new AppError(403, "Not authorized for this synthetic payment");
  return (
    await pool.query(
      `SELECT id,state,amount,currency,provider,event_id,last_error,created_at,
    CASE WHEN tenant_id=$2 AND state='pending' THEN checkout_url ELSE NULL END AS checkout_url
    FROM payment_attempts WHERE payment_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [paymentId, userId],
    )
  ).rows;
}
export async function initiateSandbox(
  userId: number,
  paymentId: string,
  provider: SandboxProvider = configuredProvider(),
) {
  requireSandbox();
  const client = await pool.connect();
  let attempt: any;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT root.id FROM contracts root JOIN contracts c ON coalesce(c.root_contract_id,c.id)=root.id
      JOIN payments p ON p.contract_id=c.id WHERE p.id=$1 FOR UPDATE OF root`,
      [paymentId],
    );
    const found = await client.query(
      `SELECT p.id,p.status,p.category,rental_outstanding(p.id)::text AS remaining
      FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN sandbox_contracts s ON s.contract_id=c.id
      WHERE p.id=$1 AND c.tenant_id=$2 FOR UPDATE OF p`,
      [paymentId, userId],
    );
    if (!found.rows.length)
      throw new AppError(403, "Not authorized for this synthetic payment");
    const existing = await client.query(
      "SELECT id FROM payment_attempts WHERE payment_id=$1 AND state IN ('initiating','pending','review')",
      [paymentId],
    );
    if (existing.rows.length) {
      await client.query("COMMIT");
      return existing.rows[0];
    }
    const p = found.rows[0];
    if (
      !["pending", "overdue"].includes(p.status) ||
      p.category !== "rent" ||
      minorUnits(p.remaining) <= 0n
    )
      throw new AppError(409, "No payable rent balance");
    if (
      (
        await client.query(
          "SELECT 1 FROM payment_events WHERE payment_id=$1 AND status='pending'",
          [paymentId],
        )
      ).rows.length
    )
      throw new AppError(
        409,
        "Resolve the pending manual claim before starting sandbox checkout",
      );
    const id = randomUUID();
    attempt = (
      await client.query(
        `INSERT INTO payment_attempts(id,payment_id,tenant_id,merchant_order_id,amount,provider)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          id,
          paymentId,
          userId,
          "NIB" + id.replaceAll("-", ""),
          p.remaining,
          sandboxConfig().provider,
        ],
      )
    ).rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    const checkout = await provider.initiate(attempt);
    await pool.query(
      `UPDATE payment_attempts SET provider_order_id=$1,checkout_url=$2,state='pending',retry_at=now()+interval '5 seconds'
      WHERE id=$3 AND state='initiating'`,
      [checkout.provider_order_id, checkout.checkout_url, attempt.id],
    );
  } catch (error) {
    // The provider may have accepted the request. Never automatically submit a new charge.
    const notSubmitted = error instanceof CheckoutNotSubmitted;
    await pool.query(
      "UPDATE payment_attempts SET state=$2,last_error=$3 WHERE id=$1",
      [
        attempt.id,
        notSubmitted ? "failed" : "review",
        notSubmitted
          ? "Checkout not submitted; fix sandbox configuration and retry"
          : "Checkout outcome uncertain; reconcile before retrying",
      ],
    );
  }
  return { id: attempt.id };
}
export async function requestSandboxVerification(userId: number, id: string) {
  requireSandbox();
  const found = await pool.query(
    `SELECT a.id FROM payment_attempts a JOIN payments p ON p.id=a.payment_id
    JOIN contracts c ON c.id=p.contract_id JOIN listings l ON l.id=c.listing_id
    WHERE a.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2)`,
    [id, userId],
  );
  if (!found.rows.length)
    throw new AppError(403, "Not authorized for this payment attempt");
  await pool.query(
    `UPDATE payment_attempts SET state='pending',retry_at=now(),expires_at=now()+interval '1 hour'
    WHERE id=$1 AND state IN ('pending','review') AND provider_order_id IS NOT NULL`,
    [id],
  );
}
export async function wakeSandboxCallback(orderId: string) {
  requireSandbox();
  // Callback fields never become verification evidence. Do not disclose whether an order exists.
  await pool.query(
    "UPDATE payment_attempts SET retry_at=now() WHERE provider_order_id=$1 AND state='pending'",
    [orderId],
  );
}
export async function processOneSandboxAttempt(
  provider: SandboxProvider = configuredProvider(),
) {
  requireSandbox();
  await pool.query(`UPDATE payment_attempts SET state='review',last_error='Checkout interrupted; reconciliation required'
    WHERE state='initiating' AND created_at<now()-interval '2 minutes'`);
  const lease = randomUUID();
  const found = await pool.query(
    `UPDATE payment_attempts SET lease_token=$1,lease_until=now()+interval '1 minute',checks=checks+1
    WHERE id=(SELECT id FROM payment_attempts WHERE state='pending' AND provider=$2 AND retry_at<=now()
      AND (lease_until IS NULL OR lease_until<now()) ORDER BY retry_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    [lease, sandboxConfig().provider],
  );
  if (!found.rows.length) return false;
  const a = found.rows[0];
  try {
    const evidence = await provider.verify(a.provider_order_id);
    let status: string;
    try {
      status = validateVerification(a, evidence);
    } catch {
      status = "review";
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Root lock first; stale workers may not commit after their lease is superseded.
      await client.query(
        `SELECT root.id FROM contracts root JOIN contracts c ON coalesce(c.root_contract_id,c.id)=root.id
        JOIN payments p ON p.contract_id=c.id WHERE p.id=$1 FOR UPDATE OF root`,
        [a.payment_id],
      );
      const held = await client.query(
        "SELECT id FROM payment_attempts WHERE id=$1 AND lease_token=$2 FOR UPDATE",
        [a.id, lease],
      );
      if (!held.rows.length) {
        await client.query("ROLLBACK");
        return true;
      }
      if (status === "succeeded")
        await client.query("SELECT confirm_sandbox_payment($1,$2::jsonb)", [
          a.id,
          JSON.stringify(evidence),
        ]);
      else {
        if (
          status === "pending" &&
          new Date(a.expires_at).getTime() < Date.now()
        )
          status = "review";
        await client.query(
          `UPDATE payment_attempts SET state=$1,verification=$2,last_error=$3,
          retry_at=now()+interval '15 seconds',lease_until=NULL,lease_token=NULL WHERE id=$4`,
          [
            status,
            JSON.stringify(evidence),
            status === "review"
              ? "Verification mismatch or expired wait; reconciliation required"
              : null,
            a.id,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const reconciliation =
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P0001";
    await pool.query(
      `UPDATE payment_attempts SET state=CASE WHEN $3 OR expires_at<now() THEN 'review' ELSE state END,
      last_error=$4,retry_at=now()+interval '30 seconds',lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2`,
      [
        a.id,
        lease,
        !!reconciliation,
        reconciliation
          ? "Balance changed; reconciliation required"
          : "Verification unavailable; no payment recorded",
      ],
    );
  }
  return true;
}
export function startSandboxPaymentWorker() {
  if (!sandboxConfig().enabled) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (let n = 0; n < 5 && (await processOneSandboxAttempt()); n++) {}
    } catch {
      console.error("Sandbox verification worker unavailable");
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  return () => clearInterval(timer);
}
