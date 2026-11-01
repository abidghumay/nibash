import assert from "node:assert/strict";
import test from "node:test";
import { parseAndScoreAiResult, type RawAiDocumentOutput } from "./aiDocumentVerifier.service.js";

const complete: RawAiDocumentOutput = {
  is_valid_document: true, detected_document_type: "holding_tax_receipt", confidence_score: 95,
  summary: "Readable receipt", flags: [], extracted_data: {
    ownerNameDetected: "Owner", addressDetected: "Gulshan, Dhaka", documentNumber: "T1",
    isNameMatched: true, isAddressMatched: true,
  },
};

test("property documents require address evidence, identities do not require the rental address", () => {
  const noAddress = {...complete, extracted_data:{ownerNameDetected:'Owner',documentNumber:'N1',isNameMatched:true}};
  assert.equal(parseAndScoreAiResult(noAddress).aiStatus, 'flagged');
  assert.equal(parseAndScoreAiResult({...noAddress, detected_document_type:'nid'}, 'nid').aiStatus, 'passed');
});
test("a different document type cannot pass the claimed type", () => {
  assert.equal(parseAndScoreAiResult(complete, 'dolil_deed').aiStatus, 'flagged');
});
test("malformed extracted fields cannot be treated as proof", () => {
  for (const extracted_data of [[], {isNameMatched:'true'}, {documentNumber:123}]) {
    assert.throws(() => parseAndScoreAiResult({...complete, extracted_data} as never), /Invalid AI response/);
  }
});
test("a contradiction on a later PDF page requires review", () => {
  assert.equal(parseAndScoreAiResult({...complete, flags:['Owner mismatch on final page']}).aiStatus, 'flagged');
});
