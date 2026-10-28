import assert from "node:assert/strict";
import test from "node:test";
import { uploadDocumentSchema } from "./document.schema.js";

test("accepts a Dolil deed as an upload document type", () => {
  const result = uploadDocumentSchema.safeParse({
    document_type: "dolil_deed",
  });

  assert.equal(result.success, true);
});
