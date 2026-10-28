import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../db/pool.js";
import { getListingDocuments } from "./document.service.js";

test("returns AI verification fields with listing documents", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<{ rows: any[] }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const calls: QueryCall[] = [];
  mockablePool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes("SELECT owner_id FROM listings")) {
      return { rows: [{ owner_id: 7 }] };
    }
    if (query.includes("FROM documents")) {
      return {
        rows: [
          {
            id: 44,
            document_type: "holding_tax_receipt",
            is_verified: false,
            verification_type: null,
            uploaded_at: "2026-10-14T00:00:00.000Z",
            ai_status: "flagged",
            ai_score: 55,
            ai_summary: "Owner name needs review.",
            ai_flags: ["Name mismatch"],
            ai_extracted_data: { ownerNameDetected: "Karim Uddin" },
          },
        ],
      };
    }
    return { rows: [] };
  };
  t.after(() => {
    mockablePool.query = originalQuery;
  });

  const documents = await getListingDocuments("12", 7);

  assert.deepEqual(documents, [
    {
      id: 44,
      document_type: "holding_tax_receipt",
      is_verified: false,
      verification_type: null,
      uploaded_at: "2026-10-14T00:00:00.000Z",
      ai_status: "flagged",
      ai_score: 55,
      ai_summary: "Owner name needs review.",
      ai_flags: ["Name mismatch"],
      ai_extracted_data: { ownerNameDetected: "Karim Uddin" },
      media: [],
    },
  ]);

  const documentQuery = calls.find((call) => call.query.includes("FROM documents"));
  assert.ok(documentQuery);
  assert.match(documentQuery.query, /ai_status/i);
  assert.match(documentQuery.query, /ai_score/i);
  assert.match(documentQuery.query, /ai_summary/i);
  assert.match(documentQuery.query, /ai_flags/i);
  assert.match(documentQuery.query, /ai_extracted_data/i);
  assert.match(documentQuery.query, /ai_evaluated_at/i);
});
