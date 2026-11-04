import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import type { z } from "zod";
import { dmpSchema } from "../schemas/rental.schema.js";
import { getContractById } from "./contract.service.js";
import { getPaymentsForContract } from "./payment.service.js";
import { rentalRules } from "./rentalRules.js";
import { sandboxConfig } from './shurjoPaySandbox.js';

export async function authorizeRental(
  user: number,
  id: string,
  ownerOnly = false,
) {
  const found = await pool.query(
    `SELECT c.id,c.tenant_id,l.owner_id,c.status,c.occupancy_state FROM contracts c JOIN listings l ON l.id=c.listing_id
    WHERE c.id=$1 AND ${ownerOnly ? "l.owner_id=$2" : "(l.owner_id=$2 OR c.tenant_id=$2)"}`,
    [id, user],
  );
  if (!found.rows.length)
    throw new AppError(403, "Not authorized for this rental relationship");
  return found.rows[0];
}
export async function listMyTenants(
  user: number,
  page: number,
  limit: number,
  group: string,
) {
  const condition = `l.owner_id=$1 AND ($2='all' OR CASE WHEN c.occupancy_state='closed' THEN 'former'
    WHEN c.status='proposed' OR c.start_date>(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'upcoming' ELSE 'current' END=$2)
    AND (c.status<>'renewed' OR NOT EXISTS(SELECT 1 FROM contracts successor WHERE successor.previous_contract_id=c.id
      AND successor.status='signed' AND successor.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date))`;
  const total = (
    await pool.query(
      `SELECT count(*)::int AS total FROM contracts c JOIN listings l ON l.id=c.listing_id WHERE ${condition}`,
      [user, group],
    )
  ).rows[0].total;
  const tenants = (
    await pool.query(
      `SELECT c.id AS contract_id,c.tenant_id,u.name AS tenant_name,l.id AS listing_id,l.title AS listing_title,
    l.on_which_floor AS unit_floor,a.name AS area_name,a.city,c.start_date,c.end_date,c.status,c.occupancy_state,c.protection_state,c.protection_until,
    c.tenancy_started_on,c.move_out_date,effective_contract_rent(c.id,(now() AT TIME ZONE 'Asia/Dhaka')::date) AS effective_rent,
    CASE WHEN c.occupancy_state='closed' THEN 'former' WHEN c.status='proposed' OR c.start_date>(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'upcoming' ELSE 'current' END AS tenant_group,
    (SELECT min(p.due_date) FROM payments p WHERE p.billing_root_id=coalesce(c.root_contract_id,c.id) AND p.status IN ('pending','overdue')) AS next_due,
    (SELECT p.status FROM payments p WHERE p.billing_root_id=coalesce(c.root_contract_id,c.id) ORDER BY p.id DESC LIMIT 1) AS latest_payment_status,
    coalesce(d.status,'not_prepared') AS dmp_status
    FROM contracts c JOIN listings l ON l.id=c.listing_id JOIN users u ON u.id=c.tenant_id JOIN areas a ON a.id=l.area_id
    LEFT JOIN dmp_preparation d ON d.contract_id=c.id WHERE ${condition}
    ORDER BY c.id DESC LIMIT $3 OFFSET $4`,
      [user, group, limit, (page - 1) * limit],
    )
  ).rows;
  return {
    tenants,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}
export async function rentalDetails(user: number, id: string) {
  await authorizeRental(user, id);
  const contract = await getContractById(id, user);
  const payments = await getPaymentsForContract(user, id);
  const root = await pool.query(
    "SELECT coalesce(root_contract_id,id) AS id FROM contracts WHERE id=$1",
    [id],
  );
  const revisions = await pool.query(
    `SELECT r.id,r.contract_id,r.previous_rent,r.proposed_rent,r.effective_on,r.status,r.proposed_at,r.reviewed_at
    FROM rent_revisions r WHERE r.root_contract_id=$1 ORDER BY r.id DESC`,
    [root.rows[0].id],
  );
  const documents = await pool.query(
    `SELECT d.id,d.kind,d.issued_at,d.state,d.pdf_sha256,d.version_key,d.contract_id FROM rental_documents d
    JOIN contracts c ON c.id=d.contract_id WHERE coalesce(c.root_contract_id,c.id)=$1 ORDER BY d.id DESC`,
    [root.rows[0].id],
  );
  const events = await pool.query(
    `SELECT e.id,e.payment_id,e.amount,e.method,e.status,e.claimed_at,e.confirmed_at,r.id AS reversal_id,
    r.reason AS reversal_reason,d.id AS document_id FROM payment_events e JOIN payments p ON p.id=e.payment_id
    LEFT JOIN payment_reversals r ON r.event_id=e.id LEFT JOIN rental_documents d ON d.event_id=e.id
    WHERE p.billing_root_id=$1 ORDER BY e.id DESC`,
    [root.rows[0].id],
  );
  const dmp = await pool.query(
    "SELECT status,submission_date,self_reported_reference,updated_at FROM dmp_preparation WHERE contract_id=$1",
    [id],
  );
  const notifications = await pool.query(
    `SELECT id,kind,title,body,created_at,read_at FROM notifications WHERE user_id=$1 AND contract_id IN
    (SELECT id FROM contracts WHERE coalesce(root_contract_id,id)=$2) ORDER BY id DESC LIMIT 30`,
    [user, root.rows[0].id],
  );
  return {
    contract,
    payment_sandbox: sandboxConfig().enabled && (await pool.query('SELECT 1 FROM sandbox_contracts WHERE contract_id=$1',[id])).rows.length > 0,
    payment_sandbox_provider: sandboxConfig().enabled ? sandboxConfig().provider : undefined,
    payments,
    revisions: revisions.rows,
    documents: documents.rows,
    events: events.rows,
    notifications: notifications.rows,
    dmp: dmp.rows[0] ?? { status: "not_prepared" },
    rules: rentalRules,
    dmp_guidance: {
      collection_enabled: false,
      export_enabled: false,
      submission_integration: false,
      requirements_verified: false,
      message:
        "Preparation and self-reported tracking only. Consult the current official DMP form and local police station. Missing official fields have not been inferred. Identity images and household data are not collected here.",
      form_url: "https://dmp.gov.bd/important-forms/tenant-registration-form/",
      information_url: "https://dmp.gov.bd/citizen-info-management-system/",
    },
  };
}
export async function updateDmp(
  user: number,
  id: string,
  data: z.infer<typeof dmpSchema>,
) {
  const c = await authorizeRental(user, id, true);
  if (!["signed", "renewed", "completed"].includes(c.status))
    throw new AppError(400, "An accepted rental relationship is required");
  if (
    data.submission_date &&
    data.submission_date >
      new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" })
  )
    throw new AppError(400, "Submission date cannot be in the future");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO dmp_preparation(contract_id,status,submission_date,self_reported_reference,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(contract_id) DO UPDATE SET status=excluded.status,submission_date=excluded.submission_date,self_reported_reference=excluded.self_reported_reference,updated_by=excluded.updated_by,updated_at=now()`,
      [
        id,
        data.status,
        data.submission_date ?? null,
        data.self_reported_reference ?? null,
        user,
      ],
    );
    await client.query(
      "INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES($1,$2,'dmp_preparation_updated',jsonb_build_object('self_reported_status',$3::text))",
      [id, user, data.status],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function requestCorrection(
  user: number,
  id: string,
  message: string,
) {
  const c = await authorizeRental(user, id);
  if (c.tenant_id !== user)
    throw new AppError(
      403,
      "Only the tenant can request correction of their information",
    );
  await pool.query(
    `INSERT INTO notifications(user_id,contract_id,kind,title,body) VALUES($1,$2,'tenant_correction','Tenant information correction requested',$3)`,
    [c.owner_id, id, message],
  );
  await pool.query(
    "INSERT INTO rental_audit_events(contract_id,actor_id,kind) VALUES($1,$2,'tenant_correction_requested')",
    [id, user],
  );
}
export async function closeRental(
  user: number,
  id: string,
  data: {
    move_out_date: string;
    inspection_note: string;
    settlement_note: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT l.id FROM contracts c JOIN listings l ON l.id=c.listing_id
      WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF l`,[id,user]);
    // Serialize with condition evidence and renewed-tenancy operations on the same root.
    await client.query(`SELECT root.id FROM contracts c
      JOIN contracts root ON root.id=coalesce(c.root_contract_id,c.id)
      JOIN listings l ON l.id=c.listing_id
      WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF root`,[id,user]);
    const result = await client.query(
      `SELECT c.*,l.owner_id FROM contracts c JOIN listings l ON l.id=c.listing_id
      WHERE c.id=$1 AND (c.tenant_id=$2 OR l.owner_id=$2) FOR UPDATE OF c,l`,
      [id, user],
    );
    if (!result.rows.length)
      throw new AppError(403, "Not authorized for this rental");
    const c = result.rows[0];
    if (c.status !== "signed")
      throw new AppError(400, "Only the current signed contract can be closed");
    // Older installations/tests can still use legacy closure before migration 022.
    if ((await client.query("SELECT to_regclass('public.move_out_inspections') AS relation")).rows[0].relation &&
      (await client.query("SELECT id FROM move_out_inspections WHERE contract_id=$1",[id])).rows.length)
      throw new AppError(409,"Complete the move-out inspection and both parties' physical vacancy confirmations in the inspection page");
    const date = (
      await client.query(
        "SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date::text AS today",
      )
    ).rows[0].today;
    if (
      data.move_out_date > date ||
      data.move_out_date <
        String(
          c.start_date instanceof Date
            ? c.start_date.toISOString().slice(0, 10)
            : c.start_date,
        )
    )
      throw new AppError(
        400,
        "Confirm an actual move-out date within the tenancy and not in the future",
      );
    if (
      c.occupancy_state === "move_out_pending" &&
      (String(
        c.move_out_date instanceof Date
          ? c.move_out_date.toISOString().slice(0, 10)
          : c.move_out_date,
      ) !== data.move_out_date ||
        c.inspection_note !== data.inspection_note ||
        c.settlement_note !== data.settlement_note)
    )
      throw new AppError(
        409,
        "Both parties must confirm the same move-out, inspection and settlement record",
      );
    if (
      (
        await client.query(
          "SELECT 1 FROM contracts WHERE previous_contract_id=$1 AND status IN ('proposed','signed')",
          [id],
        )
      ).rows.length
    )
      throw new AppError(
        400,
        "A continuing renewal exists; resolve it before closure",
      );
    const owner =
      c.owner_closed_at || (user === c.owner_id ? new Date() : null);
    const tenant =
      c.tenant_closed_at || (user === c.tenant_id ? new Date() : null);
    const closed = !!(owner && tenant);
    await client.query(
      `UPDATE contracts SET occupancy_state=$1,status=$2,move_out_date=$3,inspection_note=$4,settlement_note=$5,owner_closed_at=$6,tenant_closed_at=$7 WHERE id=$8`,
      [
        closed ? "closed" : "move_out_pending",
        closed ? "completed" : "signed",
        data.move_out_date,
        data.inspection_note,
        data.settlement_note,
        owner,
        tenant,
        id,
      ],
    );
    if (closed)
      await client.query(
        "UPDATE contracts SET occupancy_state='closed' WHERE root_contract_id=$1 AND status='renewed'",
        [c.root_contract_id],
      );
    await client.query(
      "INSERT INTO rental_audit_events(contract_id,actor_id,kind) VALUES($1,$2,'move_out_confirmation')",
      [id, user],
    );
    await client.query(
      `INSERT INTO notifications(user_id,contract_id,kind,title,body) VALUES($1,$2,'move_out','Move-out confirmation recorded',$3)`,
      [
        user === c.owner_id ? c.tenant_id : c.owner_id,
        id,
        closed
          ? "Both parties confirmed closure. The original agreements and payments remain available."
          : "Review the move-out, inspection and settlement record before confirming closure.",
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
