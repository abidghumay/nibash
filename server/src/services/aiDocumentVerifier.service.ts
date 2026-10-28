export type AiDocumentStatus = "auto_rejected" | "flagged" | "passed";

export interface DocumentEvaluationInput {
  documentId: number;
  documentType: string;
  mediaUrl: string;
  ownerName: string;
  listingAddress: string;
  listingTitle: string;
}

export interface RawAiDocumentOutput {
  is_valid_document: boolean;
  detected_document_type: string;
  confidence_score: number;
  summary: string;
  flags: string[];
  extracted_data: {
    ownerNameDetected?: string;
    addressDetected?: string;
    documentNumber?: string;
    issueDate?: string;
    isNameMatched?: boolean;
    isAddressMatched?: boolean;
  };
}

export interface DocumentEvaluationResult {
  isValidDocument: boolean;
  detectedDocumentType: string;
  confidenceScore: number;
  aiStatus: AiDocumentStatus;
  summary: string;
  flags: string[];
  extractedData: RawAiDocumentOutput["extracted_data"];
}

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
};

const REQUEST_TIMEOUT_MS = 15_000;

function hasMismatch(raw: RawAiDocumentOutput, flags: string[]) {
  return (
    raw.extracted_data?.isNameMatched === false ||
    raw.extracted_data?.isAddressMatched === false ||
    flags.some((flag) => flag.toLowerCase().includes("mismatch"))
  );
}

export function parseAndScoreAiResult(
  raw: RawAiDocumentOutput,
): DocumentEvaluationResult {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof raw.is_valid_document !== "boolean" ||
    typeof raw.detected_document_type !== "string" ||
    typeof raw.confidence_score !== "number" ||
    typeof raw.summary !== "string" ||
    !Array.isArray(raw.flags) ||
    typeof raw.extracted_data !== "object" ||
    raw.extracted_data === null
  ) {
    throw new Error("Invalid AI response: missing or invalid field types");
  }

  const numericScore = Number(raw.confidence_score);
  const confidenceScore = Number.isFinite(numericScore)
    ? Math.round(Math.max(0, Math.min(100, numericScore)))
    : 0;
  const flags = Array.isArray(raw.flags)
    ? raw.flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  const extractedData = raw.extracted_data ?? {};
  const isValidDocument = Boolean(raw.is_valid_document);

  let aiStatus: AiDocumentStatus;
  if (!isValidDocument || confidenceScore < 30) {
    aiStatus = "auto_rejected";
  } else if (confidenceScore < 75 || hasMismatch(raw, flags)) {
    aiStatus = "flagged";
  } else {
    aiStatus = "passed";
  }

  return {
    isValidDocument,
    detectedDocumentType: raw.detected_document_type || "unknown",
    confidenceScore,
    aiStatus,
    summary: raw.summary || "No summary provided by AI.",
    flags,
    extractedData,
  };
}

function buildVerificationPrompt(input: DocumentEvaluationInput) {
  return `You are a document triage assistant for Nibash, a rental platform in Bangladesh.

Inspect this uploaded image or PDF. Read and reason over Bengali and English text. Use the listing details only to identify discrepancies; do not claim that visual inspection alone proves legal authenticity.

Claimed document type: ${input.documentType}
Listing title: ${input.listingTitle}
Expected owner name: ${input.ownerName}
Expected property address: ${input.listingAddress}

Evaluate these questions:
1. Is this a readable, relevant legal, identity, or utility document? If it is a meme, selfie, pet photo, unrelated image, or unreadable upload, set is_valid_document to false and confidence_score below 25.
2. If it is a Dolil deed, holding-tax receipt, utility bill, NID, or trade license, extract visible owner, address, document number, and issue date details.
3. Identify visible inconsistencies between the document and the expected owner or address.
4. Return strict JSON only, without Markdown fences, matching this shape:
{
  "is_valid_document": boolean,
  "detected_document_type": string,
  "confidence_score": number,
  "summary": string,
  "flags": string[],
  "extracted_data": {
    "ownerNameDetected": string,
    "addressDetected": string,
    "documentNumber": string,
    "issueDate": string,
    "isNameMatched": boolean,
    "isAddressMatched": boolean
  }
}`;
}

export async function evaluateDocumentWithGemini(
  input: DocumentEvaluationInput,
): Promise<DocumentEvaluationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured");
  }

  const imageResponse = await fetch(input.mediaUrl, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!imageResponse.ok) {
    throw new Error(
      `Failed to fetch media from storage: ${imageResponse.statusText}`,
    );
  }

  const base64Data = Buffer.from(await imageResponse.arrayBuffer()).toString(
    "base64",
  );
  const mimeType = imageResponse.headers.get("content-type") || "image/jpeg";
  const requestBody = {
    contents: [
      {
        parts: [
          { text: buildVerificationPrompt(input) },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: {
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
      },
      temperature: 0.1,
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 300);
    throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const textContent = data.candidates?.[0]?.content?.parts?.find(
    (part) => typeof part.text === "string",
  )?.text;
  if (!textContent) {
    throw new Error("Empty response received from Gemini API");
  }

  let rawResult: RawAiDocumentOutput;
  try {
    rawResult = JSON.parse(textContent) as RawAiDocumentOutput;
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }

  return parseAndScoreAiResult(rawResult);
}
