import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../db/pool.js";
import { getUnverifiedListings } from "./listing.service.js";

test("includes AI document aggregates in the verifier queue", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<{ rows: any[] }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const calls: QueryCall[] = [];
  mockablePool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes("FROM listings l")) {
      return {
        rows: [
          {
            id: 12,
            title: "Sunny Gulshan Flat",
            rent: 32000,
            total_docs: 3,
            ai_passed_docs: 1,
            ai_rejected_docs: 1,
          },
        ],
      };
    }
    return { rows: [] };
  };
  t.after(() => {
    mockablePool.query = originalQuery;
  });

  const listings = await getUnverifiedListings();

  assert.deepEqual(listings, [
    {
      id: 12,
      title: "Sunny Gulshan Flat",
      rent: 32000,
      total_docs: 3,
      ai_passed_docs: 1,
      ai_rejected_docs: 1,
      images: [],
    },
  ]);

  assert.match(calls[0].query, /LEFT JOIN documents d ON d\.listing_id = l\.id/i);
  assert.match(calls[0].query, /ai_status = 'passed'/i);
  assert.match(calls[0].query, /ai_status = 'auto_rejected'/i);
  assert.match(calls[0].query, /GROUP BY l\.id/i);
});
