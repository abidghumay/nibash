import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../db/pool.js";
import { evaluateUploadedDocument } from "./document.service.js";

test("persists an AI evaluation for an uploaded document", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<{ rows: any[] }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const calls: QueryCall[] = [];

  process.env.GEMINI_API_KEY = "test-key";
  mockablePool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes("FROM listings l")) {
      return {
        rows: [
          {
            title: "Sunny Gulshan Flat",
            owner_name: "Rahim Chowdhury",
            area_name: "Gulshan",
            city: "Dhaka",
          },
        ],
      };
    }
    return { rows: [] };
  };
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage.example/")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    is_valid_document: true,
                    detected_document_type: "holding_tax_receipt",
                    confidence_score: 92,
                    summary: "Owner and property address match.",
                    flags: ["Owner name matched", "Address matched"],
                    extracted_data: {
                      ownerNameDetected: "Rahim Chowdhury",
                      isNameMatched: true,
                      isAddressMatched: true,
                    },
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    mockablePool.query = originalQuery;
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await evaluateUploadedDocument({
    documentId: 44,
    listingId: "12",
    documentType: "holding_tax_receipt",
    mediaUrl: "https://storage.example/document.jpg",
  });

  const updateCall = calls.find((call) => call.query.includes("ai_status = $1"));
  assert.ok(updateCall);
  assert.deepEqual(updateCall.values, [
    "passed",
    92,
    "Owner and property address match.",
    JSON.stringify(["Owner name matched", "Address matched"]),
    JSON.stringify({
      ownerNameDetected: "Rahim Chowdhury",
      isNameMatched: true,
      isAddressMatched: true,
    }),
    44,
  ]);
});

test("marks the document failed when the AI service is unavailable", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<{ rows: any[] }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalConsoleError = console.error;
  const calls: QueryCall[] = [];

  delete process.env.GEMINI_API_KEY;
  console.error = () => {};
  mockablePool.query = async (query, values) => {
    calls.push({ query, values });
    return {
      rows: [
        {
          title: "Sunny Gulshan Flat",
          owner_name: "Rahim Chowdhury",
          area_name: "Gulshan",
          city: "Dhaka",
        },
      ],
    };
  };
  t.after(() => {
    mockablePool.query = originalQuery;
    console.error = originalConsoleError;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await evaluateUploadedDocument({
    documentId: 45,
    listingId: "12",
    documentType: "holding_tax_receipt",
    mediaUrl: "https://storage.example/document.jpg",
  });

  const failureUpdate = calls.find((call) =>
    call.query.includes("ai_status = 'failed'"),
  );
  assert.ok(failureUpdate);
  assert.match(failureUpdate.query, /ai_evaluated_at\s*=\s*now\(\)/i);
  assert.deepEqual(failureUpdate.values, [45]);
});

test("only writes an AI result when the queued media is still current", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<{ rows: any[] }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const calls: QueryCall[] = [];

  process.env.GEMINI_API_KEY = "test-key";
  mockablePool.query = async (query, values) => {
    calls.push({ query, values });
    if (query.includes("FROM listings l")) {
      return {
        rows: [
          {
            title: "Sunny Gulshan Flat",
            owner_name: "Rahim Chowdhury",
            area_name: "Gulshan",
            city: "Dhaka",
          },
        ],
      };
    }
    return { rows: [] };
  };
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage.example/")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    is_valid_document: true,
                    detected_document_type: "holding_tax_receipt",
                    confidence_score: 92,
                    summary: "Owner and property address match.",
                    flags: [],
                    extracted_data: {},
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    mockablePool.query = originalQuery;
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await evaluateUploadedDocument({
    documentId: 46,
    listingId: "12",
    documentType: "holding_tax_receipt",
    mediaUrl: "https://storage.example/document.jpg",
    mediaPath: "documents/12/holding_tax_receipt/newer.jpg",
  } as never);

  const updateCall = calls.find((call) => call.query.includes("ai_status = $1"));
  assert.ok(updateCall);
  assert.match(updateCall.query, /ORDER BY m\.id DESC LIMIT 1/i);
  assert.deepEqual(updateCall.values?.at(-1), "documents/12/holding_tax_receipt/newer.jpg");
});
