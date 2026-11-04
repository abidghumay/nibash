import { pool } from "../db/pool.js";
import { sandboxConfig, type SandboxProvider } from "./shurjoPaySandbox.js";
import { AppError } from "../errors/AppError.js";

export function requireSimulation() {
  const config = sandboxConfig();
  if (!config.enabled || config.provider !== "simulated")
    throw new AppError(404, "Simulation disabled");
}
export const simulatedPaymentProvider: SandboxProvider = {
  async initiate(a) {
    requireSimulation();
    const order = "sim-" + a.id;
    await pool.query(
      "INSERT INTO simulated_provider_transactions(attempt_id,provider_order_id) VALUES($1,$2)",
      [a.id, order],
    );
    return { provider_order_id: order, checkout_url: null };
  },
  async verify(order) {
    requireSimulation();
    const row = (
      await pool.query(
        `SELECT a.id,a.payment_id,a.merchant_order_id,a.amount,a.currency,s.provider_order_id,
      CASE WHEN s.available_at<=now() THEN s.outcome ELSE 'pending' END AS outcome
      FROM simulated_provider_transactions s JOIN payment_attempts a ON a.id=s.attempt_id WHERE s.provider_order_id=$1`,
        [order],
      )
    ).rows[0];
    if (!row) throw new Error("Unknown simulated transaction");
    return {
      order_id: row.provider_order_id,
      customer_order_id: row.merchant_order_id,
      amount: row.amount,
      currency: row.currency,
      value1: String(row.payment_id),
      value2: row.id,
      sp_code:
        (
          { succeeded: "1000", failed: "1001", cancelled: "1002" } as Record<
            string,
            string
          >
        )[row.outcome] ?? "pending",
    };
  },
};
export async function completeSimulation(
  tenantId: number,
  id: string,
  outcome: string,
  delaySeconds: number,
) {
  requireSimulation();
  const result = await pool.query(
    `UPDATE simulated_provider_transactions s SET outcome=$1,available_at=now()+$2*interval '1 second'
    FROM payment_attempts a WHERE a.id=s.attempt_id AND a.id=$3 AND a.tenant_id=$4 AND a.provider='simulated'
    AND a.state='pending' AND s.outcome='pending' RETURNING a.id`,
    [outcome, delaySeconds, id, tenantId],
  );
  if (!result.rows.length)
    throw new AppError(
      409,
      "Simulation is unavailable, already completed, or belongs to another tenant",
    );
}
