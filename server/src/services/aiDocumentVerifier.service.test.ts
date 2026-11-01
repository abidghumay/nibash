import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDocumentWithGemini,
  parseAndScoreAiResult,
} from "./aiDocumentVerifier.service.js";

test("uses the working default model unless GEMINI_MODEL overrides it", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalModel = process.env.GEMINI_MODEL;
  const originalKey = process.env.GEMINI_API_KEY;
  const requested: string[] = [];
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
  globalThis.fetch = (async (url) => {
    requested.push(String(url));
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      is_valid_document: false, detected_document_type: "other", confidence_score: 0,
      summary: "Synthetic", flags: [], extracted_data: {},
    }) }] } }] });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = originalModel;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  });
  const input = { documentId: 1, documentType: "nid" as const,
    media: { buffer: Buffer.from("test"), mimeType: "image/jpeg" },
    ownerName: "Synthetic", listingAddress: "Synthetic", listingTitle: "Synthetic" };
  await evaluateDocumentWithGemini(input);
  process.env.GEMINI_MODEL = "custom-model";
  await evaluateDocumentWithGemini(input);
  assert.match(requested[0], /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.match(requested[1], /models\/custom-model:generateContent$/);
});

test("auto-rejects an invalid document", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: false,
    detected_document_type: "unrelated_image",
    confidence_score: 10,
    summary: "The image is unrelated to a property document.",
    flags: ["Not a legal document"],
    extracted_data: {},
  });

  assert.equal(result.aiStatus, "auto_rejected");
  assert.equal(result.confidenceScore, 10);
  assert.equal(result.isValidDocument, false);
});

test("flags an otherwise valid document with a name mismatch", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "holding_tax_receipt",
    confidence_score: 84,
    summary: "The receipt has a different owner name.",
    flags: ["Name mismatch"],
    extracted_data: {
      ownerNameDetected: "Karim Uddin",
      isNameMatched: false,
    },
  });

  assert.equal(result.aiStatus, "flagged");
  assert.equal(result.confidenceScore, 84);
});

test("passes screening with complete matching extracted evidence", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "holding_tax_receipt",
    confidence_score: 92,
    summary: "Official tax receipt matching the owner and address.",
    flags: ["Owner name matched", "Address matched"],
    extracted_data: {
      ownerNameDetected: "Rahim Chowdhury",
      addressDetected: "Gulshan, Dhaka",
      documentNumber: "T1",
      isNameMatched: true,
      isAddressMatched: true,
    },
  });

  assert.equal(result.aiStatus, "passed");
  assert.equal(result.confidenceScore, 92);
});

test("clamps an out-of-range confidence score before assigning status", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 180,
    summary: "Valid identity document.",
    flags: [],
    extracted_data: {},
  });

  assert.equal(result.confidenceScore, 100);
  assert.equal(result.aiStatus, "flagged");
});

test("rounds a fractional confidence score for integer persistence", () => {
  const result = parseAndScoreAiResult({
    is_valid_document: true,
    detected_document_type: "nid",
    confidence_score: 75.5,
    summary: "Valid identity document.",
    flags: [],
    extracted_data: {},
  });

  assert.equal(result.confidenceScore, 76);
  assert.equal(result.aiStatus, "flagged");
});

test("rejects parseable JSON with invalid field types", () => {
  assert.throws(
    () =>
      parseAndScoreAiResult({
        is_valid_document: "false",
        detected_document_type: "nid",
        confidence_score: 92,
        summary: "Invalid field type.",
        flags: [],
        extracted_data: {},
      } as never),
    /Invalid AI response/i,
  );
});

test("asks Gemini for a response matching the document evaluation schema", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  let modelRequest: Record<string, unknown> | undefined;

  process.env.GEMINI_API_KEY = "test-key";
  globalThis.fetch = (async (url, init) => {
    if (String(url) === "https://storage.example/document.jpg") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    modelRequest = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    is_valid_document: true,
                    detected_document_type: "nid",
                    confidence_score: 92,
                    summary: "Valid identity document.",
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
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  await evaluateDocumentWithGemini({
    documentId: 1,
    documentType: "nid",
    media: { buffer: Buffer.from("synthetic document"), mimeType: "image/jpeg" },
    ownerName: "Rahim Chowdhury",
    listingAddress: "Gulshan, Dhaka",
    listingTitle: "Sunny Gulshan Flat",
  });

  const generationConfig = modelRequest?.generationConfig as
    | Record<string, unknown>
    | undefined;
  assert.equal(generationConfig?.response_mime_type, "application/json");
  assert.deepEqual(generationConfig?.response_schema, {
    type: "object",
    required: [
      "is_valid_document",
      "detected_document_type",
      "confidence_score",
      "summary",
      "flags",
      "extracted_data",
    ],
    properties: {
      is_valid_document: { type: "boolean" },
      detected_document_type: { type: "string" },
      confidence_score: { type: "number" },
      summary: { type: "string" },
      flags: { type: "array", items: { type: "string" } },
      extracted_data: {
        type: "object",
        properties: {
          ownerNameDetected: { type: "string" },
          addressDetected: { type: "string" },
          documentNumber: { type: "string" },
          issueDate: { type: "string" },
          isNameMatched: { type: "boolean" },
          isAddressMatched: { type: "boolean" },
        },
      },
    },
  });
});
