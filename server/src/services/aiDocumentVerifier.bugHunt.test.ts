/**
 * Bug-hunting tests for the AI Document Verification pipeline.
 *
 * Each test targets a specific edge case or suspected defect in
 * parseAndScoreAiResult, evaluateDocumentWithGemini, or
 * evaluateUploadedDocument.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDocumentWithGemini,
  parseAndScoreAiResult,
  type RawAiDocumentOutput,
} from "./aiDocumentVerifier.service.js";

// ─── parseAndScoreAiResult edge cases ────────────────────────────────

test("BUG-HUNT: negative confidence_score should clamp to 0", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: -50,
    summary: "Score was negative.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.confidenceScore, 0);
  // Score 0 < 30 → should be auto_rejected even though is_valid_document=true
  assert.equal(result.aiStatus, "auto_rejected");
});

test("BUG-HUNT: confidence_score of exactly 30 should NOT be auto_rejected", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 30,
    summary: "Borderline score.",
    flags: [],
    extracted_data: {},
  });
  // 30 is not < 30, so should be flagged (since 30 < 75)
  assert.notEqual(result.aiStatus, "auto_rejected");
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: confidence_score of exactly 75 cannot pass without extracted evidence", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 75,
    summary: "Borderline pass.",
    flags: [],
    extracted_data: {},
  });
  // 75 is NOT < 75, and no mismatch → should be 'passed'
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: NaN confidence_score should fall back to 0 and auto_reject", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: NaN,
    summary: "NaN score.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.confidenceScore, 0);
  assert.equal(result.aiStatus, "auto_rejected");
});

test("BUG-HUNT: address mismatch alone should flag even with high score", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "holding_tax_receipt",
    confidence_score: 95,
    summary: "High confidence but address does not match.",
    flags: [],
    extracted_data: {
      isNameMatched: true,
      isAddressMatched: false,
    },
  });
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: flag text with 'mismatch' keyword flags even if extracted_data matches", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "dolil_deed",
    confidence_score: 88,
    summary: "Looks valid but has mismatch warning.",
    flags: ["Possible name MISMATCH detected"],
    extracted_data: {
      isNameMatched: true,
      isAddressMatched: true,
    },
  });
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: non-string flags in array should be filtered out", () => {
  const raw = {
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 85,
    summary: "Has mixed flag types.",
    flags: ["valid flag", 123, null, undefined, true, "another flag"],
    extracted_data: {},
  } as unknown as RawAiDocumentOutput;

  const result = parseAndScoreAiResult(raw);
  // Should only keep string flags
  assert.deepEqual(result.flags.slice(0, 2), ["valid flag", "another flag"]);
});

test("BUG-HUNT: empty extracted_data should not crash hasMismatch", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 80,
    summary: "No extracted data at all.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: null passed as raw input should throw", () => {
  assert.throws(
    () => parseAndScoreAiResult(null as never),
    /Invalid AI response/i,
  );
});

test("BUG-HUNT: missing extracted_data field should throw", () => {
  assert.throws(
    () =>
      parseAndScoreAiResult({
        is_valid_document: true,
        detected_document_type: "nid",
        confidence_score: 80,
        summary: "Missing extracted_data.",
        flags: [],
      } as never),
    /Invalid AI response/i,
  );
});

test("BUG-HUNT: extracted_data as null should throw", () => {
  assert.throws(
    () =>
      parseAndScoreAiResult({
        is_valid_document: true,
        detected_document_type: "nid",
        confidence_score: 80,
        summary: "Null extracted_data.",
        flags: [],
        extracted_data: null,
      } as never),
    /Invalid AI response/i,
  );
});

test("BUG-HUNT: empty summary should be replaced with default", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 90,
    summary: "",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.summary, "No summary provided by AI.");
});

test("BUG-HUNT: empty detected_document_type should be replaced with 'unknown'", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "",
    confidence_score: 90,
    summary: "Valid doc but empty type.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.detectedDocumentType, "unknown");
});

test("BUG-HUNT: is_valid_document=false should auto_reject regardless of high score", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: false,
    detected_document_type: "dolil_deed",
    confidence_score: 99,
    summary: "Invalid but high score.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.aiStatus, "auto_rejected");
});

// ─── evaluateDocumentWithGemini edge cases ───────────────────────────

test("BUG-HUNT: missing GEMINI_API_KEY throws descriptive error", async (t) => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await assert.rejects(
    () =>
      evaluateDocumentWithGemini({
        documentId: 1,
        documentType: "nid",
        media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
        ownerName: "Test",
        listingAddress: "Dhaka",
        listingTitle: "Test Listing",
      }),
    /GEMINI_API_KEY/i,
  );
});

test("BUG-HUNT: Gemini API returning HTTP error throws with status", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    // Gemini API returns 429 rate limit
    return new Response("Rate limit exceeded", { status: 429 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await assert.rejects(
    () =>
      evaluateDocumentWithGemini({
        documentId: 1,
        documentType: "nid",
        media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
        ownerName: "Test",
        listingAddress: "Dhaka",
        listingTitle: "Test Listing",
      }),
    /Gemini API error \(429\)/,
  );
});

test("BUG-HUNT: Gemini returns valid JSON but empty candidates array", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response(JSON.stringify({ candidates: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await assert.rejects(
    () =>
      evaluateDocumentWithGemini({
        documentId: 1,
        documentType: "nid",
        media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
        ownerName: "Test",
        listingAddress: "Dhaka",
        listingTitle: "Test Listing",
      }),
    /Empty response/i,
  );
});

test("BUG-HUNT: Gemini returns non-JSON text in parts", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "This is not valid JSON at all" }] } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await assert.rejects(
    () =>
      evaluateDocumentWithGemini({
        documentId: 1,
        documentType: "nid",
        media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
        ownerName: "Test",
        listingAddress: "Dhaka",
        listingTitle: "Test Listing",
      }),
    /invalid JSON/i,
  );
});

// Storage errors and version races are covered by documentLifecycle.integration.test.ts.

test("BUG-HUNT: Gemini response with markdown-fenced JSON should fail gracefully", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async (url) => {
    if (String(url).startsWith("https://storage")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    // Gemini sometimes wraps JSON in markdown fences despite response_mime_type
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '```json\n{"is_valid_document":true,"detected_document_type":"nid","confidence_score":85,"summary":"Valid.","flags":[],"extracted_data":{}}\n```',
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
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  // The current code does JSON.parse(textContent) without stripping markdown fences.
  // If Gemini wraps the response in ```json ... ```, JSON.parse will throw.
  await assert.rejects(
    () =>
      evaluateDocumentWithGemini({
        documentId: 1,
        documentType: "nid",
        media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
        ownerName: "Test",
        listingAddress: "Dhaka",
        listingTitle: "Test Listing",
      }),
    /invalid JSON/i,
    "Should fail when Gemini wraps response in markdown fences — no fence stripping logic exists",
  );
});

test("BUG-HUNT: confidence_score of 29.5 rounds to 30 but original < 30 check was pre-round", () => {
  // This tests whether the rounding happens BEFORE or AFTER the status decision.
  // Code flow: numericScore=29.5 → Math.round(29.5) = 30 → confidenceScore=30
  // Then: confidenceScore < 30 is false (30 < 30 = false)
  // So a raw 29.5 should NOT be auto_rejected (it rounds up to 30)
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 29.5,
    summary: "Right at boundary after rounding.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.confidenceScore, 30);
  // Rounds to 30, which is >= 30, so NOT auto_rejected → should be flagged
  assert.equal(result.aiStatus, "flagged");
});

test("BUG-HUNT: confidence_score of 74.5 rounds to 75 — still needs evidence after rounding", () => {
  // 74.5 rounds to 75 (banker's rounding or standard), 75 is NOT < 75 → passed
  // BUT Math.round(74.5) = 75 in JS (rounds half up)
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 74.5,
    summary: "Boundary between flagged and passed.",
    flags: [],
    extracted_data: {},
  });
  assert.equal(result.confidenceScore, 75);
  assert.equal(result.aiStatus, "flagged");
});
