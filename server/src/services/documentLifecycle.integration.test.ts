import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pool } from "../db/pool.js";
import { uploadListingDocument, getListingDocuments, verifyDocument } from "./document.service.js";
import { parseAndScoreAiResult } from "./aiDocumentVerifier.service.js";
import { claimDocumentAiJob, finishDocumentAiJob, processOneDocumentAiJob, cleanupOneDocumentObject } from "./documentAiJobs.service.js";
import { migratePrivateDocuments } from "../scripts/migratePrivateDocuments.js";

test("high confidence cannot pass missing extracted evidence", () => {
  const result = parseAndScoreAiResult({ is_valid_document: true,
    detected_document_type: "nid", confidence_score: 99, summary: "Looks plausible",
    flags: [], extracted_data: {} });
  assert.equal(result.aiStatus, "flagged");
});

test("fresh migrations and document replacement lifecycle", async (t) => {
  const db = new PGlite({ extensions: { pg_trgm } });
  t.after(() => db.close());
  const dir = resolve(__dirname, "../../../db/migrations");
  for (const name of (await readdir(dir)).filter(n => n.endsWith(".sql")).sort()) {
    await db.exec((await readFile(resolve(dir, name), "utf8")).replace(/^\uFEFF/, ""));
  }
  await db.exec(`
    INSERT INTO users (name,nid,phone,password_hash) VALUES
      ('Owner','1','1','x'), ('Reviewer','2','2','x'), ('Stranger','3','3','x');
    INSERT INTO owners VALUES (1); INSERT INTO verifiers VALUES (2);
    INSERT INTO areas (name,city,latitude,longitude,radius) VALUES ('Gulshan','Dhaka',1,1,1);
    INSERT INTO listings (title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
      VALUES ('Flat','Test',1,1,2,1,1,1,1);
  `);
  const originalQuery = pool.query, originalConnect = pool.connect, originalFetch = globalThis.fetch;
  const requests: {url: string; init?: RequestInit}[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool.query = query as never;
  pool.connect = (async () => ({ query, release() {} })) as never;
  globalThis.fetch = (async (url, init) => {
    requests.push({url: String(url), init});
    if (String(url).includes('/bucket/')) return Response.json({public: false});
    if (String(url).includes('/object/sign/')) return Response.json({signedURL:'/object/sign/verification-documents/test.pdf?token=test'});
    return new Response(null, {status: 201});
  }) as typeof fetch;
  t.after(() => { pool.query = originalQuery; pool.connect = originalConnect; globalThis.fetch = originalFetch; });
  const file = {mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic')} as Express.Multer.File;

  await assert.rejects(uploadListingDocument('1', 1, 'nid', [file, file]), /one file/i);
  await assert.rejects(uploadListingDocument('1', 3, 'nid', [file]), /authorized/i);
  assert.equal(requests.length, 0);
  const first = await uploadListingDocument('1', 1, 'nid', [file]);
  const oldJob = (await claimDocumentAiJob())!;
  const second = await uploadListingDocument('1', 1, 'nid', [file]);
  assert.equal(first.documentId, second.documentId);
  const docs = await db.query<any>('SELECT * FROM documents');
  assert.equal(docs.rows.length, 1);
  assert.equal(docs.rows[0].upload_version, 2);
  const media = await db.query<any>('SELECT m.* FROM media m JOIN document_media dm ON dm.media_id=m.id');
  assert.equal(media.rows.length, 1);
  assert.equal(media.rows[0].media_type, 'document');
  assert.equal(media.rows[0].mime_type, 'application/pdf');
  assert.equal(media.rows[0].storage_bucket, 'verification-documents');
  const jobs = await db.query<any>('SELECT * FROM document_ai_jobs ORDER BY upload_version');
  assert.equal(jobs.rows.length, 2);
  assert.equal(jobs.rows[1].status, 'queued');
  assert.ok(requests.filter(r => r.init?.method === 'POST').every(r => r.url.includes('/verification-documents/')));
  await assert.rejects(getListingDocuments('1', 3), /authorized/i);
  const listed = await getListingDocuments('1', 2);
  assert.ok(listed[0].media[0].url.includes('/object/sign/'));
  await assert.rejects((verifyDocument as Function)(String(first.documentId), 2, {upload_version: 1, reason: 'Examined owner identity', override_ai: true}), /changed/i);
  await assert.rejects((verifyDocument as Function)(String(first.documentId), 2, {upload_version: 2, reason: 'Examined owner identity', override_ai: false}), /override/i);
  await (verifyDocument as Function)(String(first.documentId), 2, {upload_version: 2, reason: 'Examined owner identity', override_ai: true});
  const audit = await db.query<any>('SELECT * FROM document_reviews');
  assert.equal(audit.rows[0].upload_version, 2);
  assert.equal(audit.rows[0].verifier_id, 2);
  await uploadListingDocument('1', 1, 'nid', [file]);
  assert.equal((await db.query<any>('SELECT is_verified FROM documents')).rows[0].is_verified, false);
  assert.equal((await db.query<any>('SELECT * FROM document_reviews')).rows.length, 1);

  await t.test('late success and failure cannot overwrite a newer upload', async () => {
    await db.exec("UPDATE documents SET ai_status='passed', ai_summary='Newest result'");
    await finishDocumentAiJob({...oldJob, attempt_count:3});
    assert.equal((await db.query<any>('SELECT ai_status FROM documents')).rows[0].ai_status, 'passed');
    await db.query("UPDATE document_ai_jobs SET status='running', lease_token=$1 WHERE id=$2", [oldJob.lease_token, oldJob.id]);
    await finishDocumentAiJob(oldJob, {aiStatus:'passed', confidenceScore:99, isValidDocument:true,
      detectedDocumentType:'nid', summary:'Old result', flags:[], extractedData:{}});
    assert.equal((await db.query<any>('SELECT ai_summary FROM documents')).rows[0].ai_summary, 'Newest result');
    await db.exec("UPDATE documents SET ai_status='pending'");
  });
  await t.test('expired leases recover, and the expired worker loses write authority', async () => {
    const claimed = (await claimDocumentAiJob())!;
    await db.query(`UPDATE document_ai_jobs SET lease_until=now()-interval '1 second' WHERE id=$1`, [claimed.id]);
    const recovered = (await claimDocumentAiJob())!;
    assert.equal(recovered.id, claimed.id);
    assert.notEqual(recovered.lease_token, claimed.lease_token);
    await finishDocumentAiJob(claimed);
    assert.equal((await db.query<any>('SELECT status FROM document_ai_jobs WHERE id=$1', [claimed.id])).rows[0].status, 'running');
    await finishDocumentAiJob(recovered);
    const retried = (await db.query<any>('SELECT * FROM document_ai_jobs WHERE id=$1', [claimed.id])).rows[0];
    assert.equal(retried.status, 'queued');
    assert.ok(new Date(retried.next_retry_at).getTime() > Date.now());
  });
  await t.test('current job sends complete PDF bytes privately to Gemini', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'synthetic-test-key';
    let submitted: any;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/object/authenticated/verification-documents/')) {
        assert.ok((init?.headers as Record<string,string>).Authorization);
        return new Response(new Uint8Array(file.buffer));
      }
      assert.ok(String(url).startsWith('https://generativelanguage.googleapis.com/'));
      submitted = JSON.parse(String(init?.body));
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({
        is_valid_document:true, detected_document_type:'nid', confidence_score:95,
        summary:'Screened', flags:[], extracted_data:{ownerNameDetected:'Owner', documentNumber:'N1', isNameMatched:true}
      })}]}}]});
    }) as typeof fetch;
    try { assert.equal(await processOneDocumentAiJob(), true); }
    finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY=originalKey;
    }
    assert.equal(submitted.contents[0].parts[1].inline_data.data, file.buffer.toString('base64'));
    assert.equal(submitted.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
    const current = (await db.query<any>('SELECT * FROM documents')).rows[0];
    assert.equal(current.ai_status, 'passed');
    assert.equal(current.is_verified, false);
  });
  await t.test('crash on the last attempt reaches a terminal status', async () => {
    await db.exec(`UPDATE document_ai_jobs SET status='running', attempt_count=3,
      lease_until=now()-interval '1 second', next_retry_at=now()-interval '1 minute'
      WHERE upload_version=3`);
    await processOneDocumentAiJob();
    assert.equal((await db.query<any>('SELECT ai_status FROM documents')).rows[0].ai_status, 'failed');
  });
  await t.test('cleanup retries deletions but never deletes an attached object', async () => {
    globalThis.fetch = (async () => new Response(null, {status:503})) as typeof fetch;
    assert.equal(await cleanupOneDocumentObject(), false);
    assert.ok((await db.query<any>('SELECT * FROM document_storage_cleanup')).rows.length > 0);
    await db.exec(`UPDATE document_storage_cleanup SET next_attempt_at=now()+interval '5 minutes';
      INSERT INTO document_storage_cleanup (storage_bucket,media_path)
      SELECT storage_bucket,media_path FROM media`);
    globalThis.fetch = (async () => {throw new Error('Must not delete attached object');}) as typeof fetch;
    assert.equal(await cleanupOneDocumentObject(), true);
    assert.equal((await db.query<any>('SELECT * FROM document_media')).rows.length, 1);
  });
  await t.test('a rolled-back upload preserves the current attachment and leaves durable orphan cleanup', async () => {
    const connected = pool.connect;
    globalThis.fetch = (async url => String(url).includes('/bucket/')
      ? Response.json({public:false}) : new Response(null,{status:201})) as typeof fetch;
    pool.connect = (async () => ({release(){}, query: async (sql:string, values?:unknown[]) => {
      if (sql.includes('INSERT INTO document_ai_jobs')) throw new Error('Injected database failure');
      return query(sql,values);
    }})) as never;
    const before = (await db.query<any>('SELECT * FROM document_media')).rows;
    try { await assert.rejects(uploadListingDocument('1',1,'nid',[file]), /Injected/); }
    finally {pool.connect=connected;}
    assert.deepEqual((await db.query<any>('SELECT * FROM document_media')).rows, before);
    assert.equal((await db.query<any>('SELECT upload_version FROM documents')).rows[0].upload_version, 3);
    const orphan = await db.query<any>(`SELECT * FROM document_storage_cleanup
      WHERE next_attempt_at>now()+interval '30 minutes'`);
    assert.equal(orphan.rows.length,1);
    await db.query('UPDATE document_storage_cleanup SET next_attempt_at=now() WHERE media_path=$1',[orphan.rows[0].media_path]);
    assert.equal(await cleanupOneDocumentObject(),true);
    assert.equal((await db.query<any>('SELECT * FROM document_storage_cleanup WHERE media_path=$1',[orphan.rows[0].media_path])).rows.length,0);
  });
  await t.test('legacy migration verifies private bytes before swapping references and queues the public copy for removal', async () => {
    await db.exec(`INSERT INTO documents (listing_id,document_type) VALUES (1,'passport');
      INSERT INTO media (media_type,media_path,mime_type) VALUES ('document','documents/legacy/passport.pdf','application/pdf');
      INSERT INTO document_media SELECT d.id,m.id FROM documents d,media m
        WHERE d.document_type='passport' AND m.media_path='documents/legacy/passport.pdf';`);
    let copied: Buffer | undefined;
    globalThis.fetch = (async (url,init) => {
      if (String(url).includes('/bucket/')) return Response.json({public:false});
      if (init?.method === 'POST') {copied=Buffer.from(init.body as unknown as Uint8Array); return new Response(null,{status:201});}
      return new Response(new Uint8Array(file.buffer));
    }) as typeof fetch;
    assert.deepEqual(await migratePrivateDocuments(),{legacyAttachments:1,migrated:0});
    assert.deepEqual(await migratePrivateDocuments(true),{legacyAttachments:1,migrated:1});
    assert.deepEqual(copied,file.buffer);
    const legacy = await db.query<any>(`SELECT m.* FROM media m JOIN document_media dm ON dm.media_id=m.id
      JOIN documents d ON d.id=dm.document_id WHERE d.document_type='passport'`);
    assert.equal(legacy.rows[0].storage_bucket,'verification-documents');
    assert.equal((await db.query<any>("SELECT * FROM document_storage_cleanup WHERE storage_bucket='listing-images'")).rows.length,1);
    assert.deepEqual(await migratePrivateDocuments(true),{legacyAttachments:0,migrated:0});
  });
});
