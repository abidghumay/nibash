import assert from "node:assert/strict";
import test from "node:test";
import { assertPrivateDocumentBucket, signDocumentUrl, downloadDocument, uploadPrivateDocument } from "./documentStorage.service.js";

test("public or unknown bucket visibility fails closed before signing or uploading", async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({public:true}); }) as typeof fetch;
  t.after(() => {globalThis.fetch=originalFetch;});
  await assert.rejects(signDocumentUrl('verification-documents','documents/1/nid/a.pdf'), /private/);
  await assert.rejects(uploadPrivateDocument('documents/1/nid/a.pdf',Buffer.from('test'),'application/pdf'), /private/);
  assert.equal(calls, 2);
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  await assert.rejects(assertPrivateDocumentBucket(), /private/);
});
test("legacy URLs and invalid storage paths are never signed", async () => {
  await assert.rejects(signDocumentUrl('listing-images','documents/1/nid/a.pdf'), /migrated/);
  await assert.rejects(downloadDocument('verification-documents','documents/../secret.pdf'), /Invalid/);
});
test("storage failures are surfaced without provider content or sensitive URLs", async t => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async () => new Response('sensitive provider detail',{status:404})) as typeof fetch;
  t.after(() => {globalThis.fetch=originalFetch;});
  await assert.rejects(downloadDocument('verification-documents','documents/1/nid/a.pdf'), error => {
    assert.match(String(error), /404/);
    assert.doesNotMatch(String(error), /sensitive provider|documents/);
    return true;
  });
});
