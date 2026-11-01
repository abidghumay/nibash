BEGIN;

ALTER TABLE media ADD COLUMN storage_bucket text NOT NULL DEFAULT 'listing-images';
ALTER TABLE media ADD COLUMN mime_type text;
ALTER TABLE media DROP CONSTRAINT media_media_type_check;
ALTER TABLE media ADD CONSTRAINT media_media_type_check
  CHECK (media_type IN ('image', 'video', 'document'));
UPDATE media SET mime_type = CASE
  WHEN lower(media_path) LIKE '%.pdf' THEN 'application/pdf'
  WHEN lower(media_path) LIKE '%.png' THEN 'image/png'
  WHEN lower(media_path) LIKE '%.webp' THEN 'image/webp'
  ELSE 'image/jpeg' END
WHERE id IN (SELECT media_id FROM document_media);
UPDATE media SET media_type = 'document' WHERE mime_type = 'application/pdf';

ALTER TABLE documents ADD COLUMN upload_version integer NOT NULL DEFAULT 1 CHECK (upload_version > 0);
ALTER TABLE documents ADD COLUMN reviewed_at timestamptz;
ALTER TABLE documents ADD COLUMN reviewed_version integer;
ALTER TABLE documents ADD COLUMN review_reason text;

-- Preserve legacy duplicates rather than silently deleting evidence. An operator
-- must resolve these before retrying this atomic migration.
CREATE UNIQUE INDEX documents_listing_type_unique ON documents(listing_id, document_type);

CREATE TABLE document_reviews (
  id bigserial PRIMARY KEY,
  document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  upload_version integer NOT NULL,
  verifier_id integer REFERENCES verifiers(user_id) ON DELETE SET NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  ai_status_at_review text,
  override_ai boolean NOT NULL
);
-- Old approvals have no versioned audit record: require a fresh human review.
CREATE TABLE document_legacy_reviews AS
  SELECT id AS document_id, verifier_id, verification_type, uploaded_at,
         now() AS archived_at
  FROM documents WHERE is_verified;
UPDATE documents SET is_verified = false, verification_type = NULL, verifier_id = NULL;

CREATE TABLE document_ai_jobs (
  id bigserial PRIMARY KEY,
  document_id integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  upload_version integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','superseded')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(document_id, upload_version)
);
CREATE INDEX document_ai_jobs_ready ON document_ai_jobs(next_retry_at)
  WHERE status IN ('queued','running');

CREATE TABLE document_storage_cleanup (
  storage_bucket text NOT NULL,
  media_path text NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(storage_bucket, media_path)
);

-- Legacy multi-attachment submissions need a combined PDF, never a first-page pass.
UPDATE documents SET ai_status = 'flagged', ai_score = NULL,
  ai_summary = 'Legacy upload: submit one complete PDF for screening.',
  ai_evaluated_at = NULL;

COMMIT;
