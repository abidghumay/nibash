import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { DOCUMENT_BUCKET, assertPrivateDocumentBucket, downloadDocument, uploadPrivateDocument } from "../services/documentStorage.service.js";

export async function migratePrivateDocuments(apply = false) {
  const legacy = await pool.query(`SELECT DISTINCT m.* FROM media m
    JOIN document_media dm ON dm.media_id=m.id WHERE m.storage_bucket='listing-images'`);
  if (!apply) return { legacyAttachments: legacy.rows.length, migrated: 0 };
  await assertPrivateDocumentBucket();
  let migrated = 0;
  for (const item of legacy.rows) {
    const path = `documents/migrated/${randomUUID()}.${item.mime_type.split('/')[1]}`;
    await pool.query(`INSERT INTO document_storage_cleanup (storage_bucket,media_path,next_attempt_at)
      VALUES ($1,$2,now()+interval '1 hour')`, [DOCUMENT_BUCKET,path]);
    const bytes = await downloadDocument(item.storage_bucket,item.media_path);
    await uploadPrivateDocument(path,bytes,item.mime_type);
    // Verify the private copy before switching the database pointer.
    if (!(await downloadDocument(DOCUMENT_BUCKET,path)).equals(bytes)) throw new Error('Private copy verification failed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reservation = await client.query(`SELECT 1 FROM document_storage_cleanup
        WHERE storage_bucket=$1 AND media_path=$2 FOR UPDATE`, [DOCUMENT_BUCKET,path]);
      if (!reservation.rows.length) throw new Error('Copy expired; retry migration');
      const updated = await client.query(`UPDATE media SET storage_bucket=$1,media_path=$2
        WHERE id=$3 AND storage_bucket='listing-images' AND media_path=$4 RETURNING id`,
        [DOCUMENT_BUCKET,path,item.id,item.media_path]);
      if (updated.rows.length) {
        await client.query(`INSERT INTO document_storage_cleanup (storage_bucket,media_path)
          VALUES ('listing-images',$1) ON CONFLICT DO NOTHING`, [item.media_path]);
        await client.query(`DELETE FROM document_storage_cleanup WHERE storage_bucket=$1 AND media_path=$2`, [DOCUMENT_BUCKET,path]);
        migrated++;
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }
  return { legacyAttachments: legacy.rows.length, migrated };
}

if (require.main === module) {
  migratePrivateDocuments(process.argv.includes('--apply'))
    .then(result => console.log(result))
    .catch(() => { console.error('Document migration failed; safe to retry after correcting configuration'); process.exitCode=1; })
    .finally(() => pool.end());
}
