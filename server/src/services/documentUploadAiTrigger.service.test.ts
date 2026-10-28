import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../db/pool.js";
import { uploadListingDocument } from "./document.service.js";

test("schedules AI evaluation after committing a document upload", async (t) => {
  type QueryResult = { rows: any[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<QueryResult>;
    connect: () => Promise<{
      query: (query: string, values?: readonly unknown[]) => Promise<QueryResult>;
      release: () => void;
    }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const originalConnect = mockablePool.connect;
  const originalFetch = globalThis.fetch;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  let queuedJob: VoidFunction | undefined;

  mockablePool.query = async (query) => {
    if (query.includes("SELECT owner_id FROM listings")) {
      return { rows: [{ owner_id: 7 }] };
    }
    return { rows: [] };
  };
  mockablePool.connect = async () => ({
    query: async (query) => {
      if (query.includes("SELECT id FROM documents")) return { rows: [] };
      if (query.includes("INSERT INTO documents")) return { rows: [{ id: 44 }] };
      if (query.includes("INSERT INTO media")) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    release: () => {},
  });
  globalThis.fetch = (async () => new Response(null, { status: 201 })) as typeof fetch;
  globalThis.queueMicrotask = ((callback: VoidFunction) => {
    queuedJob = callback;
  }) as typeof queueMicrotask;
  t.after(() => {
    mockablePool.query = originalQuery;
    mockablePool.connect = originalConnect;
    globalThis.fetch = originalFetch;
    globalThis.queueMicrotask = originalQueueMicrotask;
  });

  const result = await uploadListingDocument(
    "12",
    7,
    "holding_tax_receipt",
    [{ mimetype: "image/jpeg", buffer: Buffer.from("image") } as Express.Multer.File],
  );

  assert.deepEqual(result, { documentId: 44, mediaIds: [99] });
  assert.equal(typeof queuedJob, "function");
});

test("resets stale AI verification data when a document is re-uploaded", async (t) => {
  type QueryCall = { query: string; values?: readonly unknown[] };
  type QueryResult = { rows: any[] };
  type MockablePool = {
    query: (query: string, values?: readonly unknown[]) => Promise<QueryResult>;
    connect: () => Promise<{
      query: (query: string, values?: readonly unknown[]) => Promise<QueryResult>;
      release: () => void;
    }>;
  };

  const mockablePool = pool as unknown as MockablePool;
  const originalQuery = mockablePool.query;
  const originalConnect = mockablePool.connect;
  const originalFetch = globalThis.fetch;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  const transactionCalls: QueryCall[] = [];

  mockablePool.query = async () => ({ rows: [{ owner_id: 7 }] });
  mockablePool.connect = async () => ({
    query: async (query, values) => {
      transactionCalls.push({ query, values });
      if (query.includes("SELECT id FROM documents")) return { rows: [{ id: 44 }] };
      if (query.includes("INSERT INTO media")) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    release: () => {},
  });
  globalThis.fetch = (async () => new Response(null, { status: 201 })) as typeof fetch;
  globalThis.queueMicrotask = (() => {}) as typeof queueMicrotask;
  t.after(() => {
    mockablePool.query = originalQuery;
    mockablePool.connect = originalConnect;
    globalThis.fetch = originalFetch;
    globalThis.queueMicrotask = originalQueueMicrotask;
  });

  await uploadListingDocument(
    "12",
    7,
    "holding_tax_receipt",
    [{ mimetype: "image/jpeg", buffer: Buffer.from("image") } as Express.Multer.File],
  );

  const resetCall = transactionCalls.find((call) =>
    call.query.includes("UPDATE documents"),
  );
  assert.ok(resetCall);
  assert.match(resetCall.query, /ai_status\s*=\s*'pending'/i);
  assert.match(resetCall.query, /ai_score\s*=\s*NULL/i);
  assert.match(resetCall.query, /ai_summary\s*=\s*NULL/i);
  assert.match(resetCall.query, /ai_flags\s*=\s*'\[\]'::jsonb/i);
  assert.match(resetCall.query, /ai_extracted_data\s*=\s*'\{\}'::jsonb/i);
  assert.match(resetCall.query, /ai_evaluated_at\s*=\s*NULL/i);
});
