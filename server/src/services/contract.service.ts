import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { CreateContractInput } from "../schemas/contract.schema.js";

export async function createContract(
  ownerId: number,
  data: CreateContractInput,
) {
  const {
    listing_id,
    tenant_id,
    rent,
    electricity_bill,
    water_bill,
    service_charge,
    monthly_due_date,
    pet_allowed,
    security_deposit,
    start_date,
    end_date,
    advance_rent,
    previous_contract_id,
  } = data;

  const isOwner = await pool.query("SELECT 1 FROM owners WHERE user_id=$1", [
    ownerId,
  ]);
  if (isOwner.rows.length === 0)
    throw new AppError(403, "you are not an owner");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const listing = await client.query("SELECT id FROM listings WHERE id=$1 AND owner_id=$2 FOR UPDATE",[listing_id,ownerId]);
    if (!listing.rows.length) throw new AppError(403,"this listing is not yours");
    if (!previous_contract_id) {
      const application=await client.query("SELECT 1 FROM applies WHERE tenant_id=$1 AND listing_id=$2 AND status='pending'",[tenant_id,listing_id]);
      if (!application.rows.length) throw new AppError(400,"A pending rental application is required");
    }

    const insertTerms = await client.query(
      "INSERT INTO terms (rent,electricity_bill,water_bill,service_charge,monthly_due_date,pet_allowed,security_deposit,advance_rent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [
        rent,
        electricity_bill,
        water_bill,
        service_charge,
        monthly_due_date,
        pet_allowed,
        security_deposit,
        advance_rent,
      ],
    );
    const termsId = insertTerms.rows[0].id;
    const insertAgreement = await client.query(
      "INSERT INTO agreements (terms_id) VALUES ($1) RETURNING terms_id",
      [termsId],
    );
    const agreementId = insertAgreement.rows[0].terms_id;
    const insertContract = await client.query(
      "INSERT INTO contracts (listing_id,tenant_id,agreement_id,start_date,end_date,status,created_by_id,previous_contract_id) VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7) RETURNING id",
      [listing_id, tenant_id, agreementId, start_date, end_date,ownerId,previous_contract_id??null],
    );
    const contractId = insertContract.rows[0].id;
    await client.query(
      "UPDATE applies SET status='approved' WHERE tenant_id=$1 AND listing_id=$2",
      [tenant_id, listing_id],
    );
    await client.query(
      "UPDATE applies SET status='rejected' WHERE listing_id=$1 AND tenant_id!=$2 AND status='pending'",
      [listing_id, tenant_id],
    );
    await client.query("COMMIT");
    return contractId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getContractById(id: string, userId: number) {
  const contract = await pool.query(
    "SELECT l.owner_id, c.tenant_id FROM contracts c JOIN listings l ON c.listing_id=l.id WHERE c.id=$1",
    [id],
  );
  if (contract.rows.length === 0) throw new AppError(404, "contract not found");
  if (
    contract.rows[0].owner_id !== userId &&
    contract.rows[0].tenant_id !== userId
  ) {
    throw new AppError(403, "not authorized");
  }
  const result = await pool.query(
    `SELECT c.id AS contract_id, c.tenant_id, c.listing_id, c.agreement_id,
         c.status, c.start_date, c.end_date, c.paid_security_deposit,
         c.protection_state,c.initial_rent,c.tenancy_started_on,c.protection_until,c.occupancy_state,
         c.move_out_date,c.accepted_at,c.previous_contract_id,c.inspection_note,c.settlement_note,c.owner_closed_at,c.tenant_closed_at,
         effective_contract_rent(c.id,(now() AT TIME ZONE 'Asia/Dhaka')::date) AS effective_rent,effective_contract_rent(c.id,c.end_date+1) AS renewal_rent,t.advance_rent,
         t.rent, t.electricity_bill, t.water_bill, t.service_charge,
         t.monthly_due_date, t.pet_allowed, t.security_deposit,
         l.title AS listing_title, l.owner_id,
         concat_ws(', ','Floor '||l.on_which_floor,ar.name,ar.city) AS property_address,
         u_tenant.name AS tenant_name, u_tenant.email AS tenant_email, u_tenant.phone AS tenant_phone,
         ten.monthly_income, ten.emergency_contact,
         u_owner.name AS owner_name, u_owner.email AS owner_email, u_owner.phone AS owner_phone
         FROM contracts c
         JOIN agreements a ON a.terms_id=c.agreement_id
         JOIN terms t ON t.id=a.terms_id
         JOIN listings l ON l.id=c.listing_id
         JOIN areas ar ON ar.id=l.area_id
         JOIN users u_tenant ON u_tenant.id=c.tenant_id
         LEFT JOIN tenants ten ON ten.user_id=c.tenant_id
         JOIN users u_owner ON u_owner.id=l.owner_id
         WHERE c.id=$1`,
    [id],
  );
  return result.rows[0];
}

export async function getActiveContractForTenant(tenantId: number) {
  const result = await pool.query(
    `SELECT c.id AS contract_id
     FROM contracts c
     WHERE c.tenant_id = $1 AND c.status IN ('proposed','signed','renewed') AND c.occupancy_state<>'closed'
     ORDER BY CASE WHEN c.status IN ('signed','renewed') AND c.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 0
       WHEN c.status='signed' THEN 1 ELSE 2 END,
       CASE WHEN c.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date THEN c.start_date END DESC,c.start_date ASC,c.id DESC
     LIMIT 1`,
    [tenantId],
  );
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0];
}

export async function signContract(id:string,userId:number) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const listing=await client.query(`SELECT l.id FROM contracts c JOIN listings l ON l.id=c.listing_id
      WHERE c.id=$1 AND c.tenant_id=$2 FOR UPDATE OF l`,[id,userId]);
    if(!listing.rows.length)throw new AppError(403,'Not authorized for this contract');
    await client.query(`SELECT root.id FROM contracts c JOIN contracts root ON root.id=coalesce(c.root_contract_id,c.id)
      WHERE c.id=$1 FOR UPDATE OF root`,[id]);
    const found=await client.query('SELECT tenant_id,status FROM contracts WHERE id=$1 FOR UPDATE',[id]);
    if (!found.rows.length || found.rows[0].tenant_id!==userId) throw new AppError(403,'Not authorized for this contract');
    if(found.rows[0].status==='signed') { await client.query('COMMIT'); return; }
    if(found.rows[0].status!=='proposed') throw new AppError(400,'Contract cannot be accepted in its current state');
    await client.query("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally {client.release();}
  // Billing starts only after acceptance commits, avoiding cross-contract transaction locks.
  // The daily catch-up recovers any transient generation failure without undoing acceptance.
  try { await pool.query('CALL generate_monthly_payments()'); }
  catch { console.error('Monthly billing catch-up required after contract acceptance'); }
}
