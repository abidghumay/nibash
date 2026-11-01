import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { evaluateDocumentWithGemini, type DocumentEvaluationResult } from "./aiDocumentVerifier.service.js";
import { DOCUMENT_BUCKET, downloadDocument, deleteDocumentObject } from "./documentStorage.service.js";

export interface DocumentAiJob {
  id: string;
  document_id: number;
  upload_version: number;
  attempt_count: number;
  lease_token: string;
}

export async function claimDocumentAiJob(): Promise<DocumentAiJob | undefined> {
  const result = await pool.query(`UPDATE document_ai_jobs SET status='running',
    attempt_count=attempt_count+1, lease_token=$1, lease_until=now()+interval '2 minutes'
    WHERE id=(SELECT id FROM document_ai_jobs
      WHERE (status='queued' AND next_retry_at<=now()) OR (status='running' AND lease_until<=now())
      ORDER BY next_retry_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [randomUUID()]);
  return result.rows[0];
}

export async function finishDocumentAiJob(job: DocumentAiJob, result?: DocumentEvaluationResult) {
  // Both paths fence by lease token AND upload version. An expired worker cannot
  // overwrite the retry worker, and an old upload cannot overwrite a replacement.
  const status = result ? "completed" : job.attempt_count >= 3 ? "failed" : "queued";
  await pool.query(`WITH finished AS (
    UPDATE document_ai_jobs SET status=$1,
      next_retry_at=now()+($2 * interval '30 seconds'), lease_until=NULL, lease_token=NULL,
      finished_at=CASE WHEN $1='queued' THEN NULL ELSE now() END
    WHERE id=$3 AND lease_token=$4 AND status='running' RETURNING document_id, upload_version
  ) UPDATE documents d SET ai_status=$5::varchar, ai_score=$6, ai_summary=$7,
      ai_flags=$8::jsonb, ai_extracted_data=$9::jsonb,
      ai_evaluated_at=CASE WHEN $5::varchar='pending' THEN NULL ELSE now() END
    FROM finished f WHERE d.id=f.document_id AND d.upload_version=f.upload_version`,
  [status, 2 ** Math.min(job.attempt_count - 1, 3), job.id, job.lease_token,
    result?.aiStatus ?? (status === "failed" ? "failed" : "pending"),
    result?.confidenceScore ?? null,
    result?.summary ?? (status === "failed" ? "Screening unavailable after retries; human review required" : "Screening retry scheduled"),
    JSON.stringify(result?.flags ?? []), JSON.stringify(result?.extractedData ?? {})]);
}

export async function processOneDocumentAiJob() {
  const job = await claimDocumentAiJob();
  if (!job) return false;
  try {
    const data = await pool.query(`SELECT d.document_type, l.title, u.name AS owner_name,
      a.name AS area_name, a.city, m.media_path, m.storage_bucket, m.mime_type
      FROM documents d JOIN listings l ON l.id=d.listing_id JOIN users u ON u.id=l.owner_id
      LEFT JOIN areas a ON a.id=l.area_id
      JOIN document_media dm ON dm.document_id=d.id JOIN media m ON m.id=dm.media_id
      WHERE d.id=$1 AND d.upload_version=$2`, [job.document_id, job.upload_version]);
    if (!data.rows.length) {
      await pool.query(`UPDATE document_ai_jobs SET status='superseded', finished_at=now(), lease_token=NULL, lease_until=NULL
        WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token]);
      return true;
    }
    if (job.attempt_count > 3) { await finishDocumentAiJob(job); return true; }
    if (data.rows.length !== 1 || data.rows[0].storage_bucket !== DOCUMENT_BUCKET) {
      throw new Error("Document requires migration or a combined PDF");
    }
    const doc = data.rows[0];
    const buffer = await downloadDocument(doc.storage_bucket, doc.media_path);
    const result = await evaluateDocumentWithGemini({
      documentId: job.document_id, documentType: doc.document_type,
      media: { buffer, mimeType: doc.mime_type }, ownerName: doc.owner_name,
      listingAddress: [doc.area_name, doc.city].filter(Boolean).join(", "), listingTitle: doc.title,
    });
    await finishDocumentAiJob(job, result);
  } catch {
    // No document contents, URLs, provider responses or credentials in logs.
    console.error(`Document screening attempt failed: job ${job.id}`);
    await finishDocumentAiJob(job);
  }
  return true;
}

export async function cleanupOneDocumentObject() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT * FROM document_storage_cleanup
      WHERE next_attempt_at<=now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const item = result.rows[0];
    if (item) {
      const params = [item.storage_bucket, item.media_path];
      const attached = await client.query("SELECT 1 FROM media WHERE storage_bucket=$1 AND media_path=$2", params);
      if (!attached.rows.length) {
        try { await deleteDocumentObject(item.storage_bucket, item.media_path); }
        catch {
          await client.query(`UPDATE document_storage_cleanup SET next_attempt_at=now()+interval '5 minutes'
            WHERE storage_bucket=$1 AND media_path=$2`, params);
          await client.query("COMMIT");
          return false;
        }
      }
      await client.query("DELETE FROM document_storage_cleanup WHERE storage_bucket=$1 AND media_path=$2", params);
    }
    await client.query("COMMIT");
    return Boolean(item);
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}

export function startDocumentWorker() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try { await processOneDocumentAiJob(); await cleanupOneDocumentObject(); }
    catch { console.error("Document worker could not reach its job store"); }
    if (!stopped) { timer = setTimeout(tick, 5000); timer.unref(); }
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
