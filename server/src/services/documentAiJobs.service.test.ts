import assert from "node:assert/strict";
import test from "node:test";
import { documentScreeningFailureCode } from "./documentAiJobs.service.js";

test("screening diagnostics identify known failures without exposing arbitrary error details", () => {
  assert.equal(documentScreeningFailureCode(new Error("GEMINI_API_KEY environment variable is not configured")), "gemini_key_missing");
  assert.equal(documentScreeningFailureCode(new Error("Gemini API error (403)")), "gemini_http_403");
  assert.equal(documentScreeningFailureCode(new Error("Document storage request failed (503)")), "storage_http_503");
  assert.equal(documentScreeningFailureCode(new DOMException("private URL and token", "TimeoutError")), "timeout");
  assert.equal(documentScreeningFailureCode(new TypeError("fetch failed: private document")), "network_error");
  assert.equal(documentScreeningFailureCode(new Error("Gemini returned invalid JSON")), "invalid_model_response");
  for (const value of [new Error("Gemini API error (403) secret-key"), new Error("https://private/doc?token=secret"), "secret", null]) {
    assert.equal(documentScreeningFailureCode(value), "unexpected_error");
  }
});
