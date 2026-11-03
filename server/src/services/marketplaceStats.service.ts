import { pool } from "../db/pool.js";

export async function getMarketplaceStats() {
  const result = await pool.query<{
    approvedApartments: number; signedAgreements: number; areasWithListings: number;
  }>(`SELECT
    (SELECT count(*)::int FROM listings WHERE status='approved') AS "approvedApartments",
    (SELECT count(*)::int FROM contracts WHERE status IN ('signed','renewed','completed')) AS "signedAgreements",
    (SELECT count(DISTINCT area_id)::int FROM listings WHERE status='approved') AS "areasWithListings"`);
  return result.rows[0];
}
