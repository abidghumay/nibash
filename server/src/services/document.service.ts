import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";
import { reviewDocumentSchema, type UploadDocumentInput } from "../schemas/document.schema.js";
import { DOCUMENT_BUCKET, DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES, uploadPrivateDocument, signDocumentUrl } from "./documentStorage.service.js";

type DocumentType = UploadDocumentInput["document_type"];

async function assertOwnerOrVerifier(listingId: string, userId: number) {
  const listing = await pool.query(
    "SELECT owner_id FROM listings WHERE id=$1",
    [listingId],
  );
  if (listing.rows.length === 0) throw new AppError(404, "listing not found");

  if (listing.rows[0].owner_id === userId) return { isOwner: true };

  const verifier = await pool.query(
    "SELECT 1 FROM verifiers WHERE user_id=$1",
    [userId],
  );
  if (verifier.rows.length > 0) return { isOwner: false };

  throw new AppError(403, "not authorized to view these documents");
}

export async function uploadListingDocument(
  listingId: string, ownerId: number, documentType: DocumentType, files: Express.Multer.File[],
) {
  if (files.length !== 1) throw new AppError(400, "Upload exactly one file; combine multiple pages into one PDF");
  const file = files[0];
  if (!DOCUMENT_MIME_TYPES.includes(file.mimetype) || !file.buffer.length || file.buffer.length > MAX_DOCUMENT_BYTES) {
    throw new AppError(400, "Use a JPEG, PNG, WebP or PDF up to 5 MB");
  }
  const listing = await pool.query("SELECT owner_id FROM listings WHERE id=$1", [listingId]);
  if (!listing.rows.length) throw new AppError(404, "listing not found");
  if (listing.rows[0].owner_id !== ownerId) throw new AppError(403, "not authorized");

  const path = `documents/${listingId}/${documentType}/${randomUUID()}.${file.mimetype.split("/")[1]}`;
  // Persist a compensating delete BEFORE storage upload. A crash, timeout, or
  // rollback leaves this job behind; a successful attachment removes it.
  await pool.query(`INSERT INTO document_storage_cleanup (storage_bucket, media_path, next_attempt_at)
    VALUES ($1,$2,now() + interval '1 hour')`, [DOCUMENT_BUCKET, path]);
  await uploadPrivateDocument(path, file.buffer, file.mimetype);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reservation = await client.query(`SELECT 1 FROM document_storage_cleanup
      WHERE storage_bucket=$1 AND media_path=$2 FOR UPDATE`, [DOCUMENT_BUCKET, path]);
    if (!reservation.rows.length) throw new AppError(409, "Upload expired; please upload the file again");
    // Serialize even two first uploads; the unique key is the database backstop.
    const locked = await client.query("SELECT owner_id FROM listings WHERE id=$1 FOR UPDATE", [listingId]);
    if (locked.rows[0]?.owner_id !== ownerId) throw new AppError(403, "not authorized");
    const inserted = await client.query(`INSERT INTO documents (listing_id, document_type)
      VALUES ($1,$2) ON CONFLICT (listing_id, document_type) DO UPDATE
      SET upload_version=documents.upload_version+1, uploaded_at=now(),
          is_verified=false, verification_type=NULL, verifier_id=NULL,
          reviewed_at=NULL, reviewed_version=NULL, review_reason=NULL,
          ai_status='pending', ai_score=NULL, ai_summary=NULL,
          ai_flags='[]'::jsonb, ai_extracted_data='{}'::jsonb, ai_evaluated_at=NULL
      RETURNING id, upload_version`, [listingId, documentType]);
    const { id: documentId, upload_version: uploadVersion } = inserted.rows[0];
    // Old media are detached atomically; storage deletion is retried after commit.
    await client.query(`INSERT INTO document_storage_cleanup (storage_bucket, media_path)
      SELECT m.storage_bucket, m.media_path FROM media m
      JOIN document_media dm ON dm.media_id=m.id WHERE dm.document_id=$1
      ON CONFLICT (storage_bucket, media_path) DO UPDATE SET next_attempt_at=now()`, [documentId]);
    await client.query(`DELETE FROM media WHERE id IN
      (SELECT media_id FROM document_media WHERE document_id=$1)`, [documentId]);
    const media = await client.query(`INSERT INTO media (media_type, media_path, storage_bucket, mime_type)
      VALUES ($1,$2,$3,$4) RETURNING id`,
      [file.mimetype === "application/pdf" ? "document" : "image", path, DOCUMENT_BUCKET, file.mimetype]);
    await client.query("INSERT INTO document_media (document_id, media_id) VALUES ($1,$2)", [documentId, media.rows[0].id]);
    await client.query(`INSERT INTO document_ai_jobs (document_id, upload_version) VALUES ($1,$2)`, [documentId, uploadVersion]);
    await client.query(`DELETE FROM document_storage_cleanup WHERE storage_bucket=$1 AND media_path=$2`, [DOCUMENT_BUCKET, path]);
    await client.query("COMMIT");
    return { documentId, mediaIds: [media.rows[0].id], uploadVersion };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

export async function getListingDocuments(listingId: string, userId: number) {
  await assertOwnerOrVerifier(listingId, userId);
  const docs = await pool.query(`SELECT id, document_type, is_verified, verification_type, uploaded_at,
    upload_version, reviewed_at, reviewed_version, review_reason, verifier_id,
    ai_status, ai_summary, ai_flags, ai_extracted_data, ai_evaluated_at
    FROM documents WHERE listing_id=$1 ORDER BY uploaded_at DESC`, [listingId]);
  if (!docs.rows.length) return [];
  const media = await pool.query(`SELECT dm.document_id, m.id, m.media_path, m.storage_bucket, m.mime_type
    FROM document_media dm JOIN media m ON m.id=dm.media_id
    WHERE dm.document_id=ANY($1) ORDER BY m.id`, [docs.rows.map(d => d.id)]);
  const byDocument = new Map<number, {id: number; url: string; mime_type: string}[]>();
  for (const row of media.rows) {
    const arr = byDocument.get(row.document_id) ?? [];
    arr.push({ id: row.id, url: await signDocumentUrl(row.storage_bucket, row.media_path), mime_type: row.mime_type });
    byDocument.set(row.document_id, arr);
  }
  return docs.rows.map(d => ({ ...d, media: byDocument.get(d.id) ?? [] }));
}

export async function verifyDocument(documentId: string, verifierId: number, input: unknown) {
  const parsed = reviewDocumentSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0].message);
  const { upload_version, reason, override_ai } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const verifier = await client.query("SELECT 1 FROM verifiers WHERE user_id=$1", [verifierId]);
    if (!verifier.rows.length) throw new AppError(403, "not a verifier");
    const result = await client.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE", [documentId]);
    const doc = result.rows[0];
    if (!doc) throw new AppError(404, "document not found");
    if (doc.upload_version !== upload_version) throw new AppError(409, "Document changed; reload and review the current upload");
    if (doc.ai_status !== "passed" && !override_ai) throw new AppError(409, "Explicit AI override required for this screening status");
    await client.query(`INSERT INTO document_reviews (document_id,upload_version,verifier_id,reason,ai_status_at_review,override_ai)
      VALUES ($1,$2,$3,$4,$5,$6)`, [documentId, upload_version, verifierId, reason, doc.ai_status, override_ai]);
    await client.query(`UPDATE documents SET is_verified=true, verification_type='manual', verifier_id=$1,
      reviewed_at=now(), reviewed_version=$2, review_reason=$3 WHERE id=$4`, [verifierId, upload_version, reason, documentId]);
    await client.query("COMMIT");
    return { id: doc.id, upload_version };
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
