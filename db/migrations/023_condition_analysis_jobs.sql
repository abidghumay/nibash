-- Separate home-evidence jobs reuse the document queue's PostgreSQL lease pattern.
CREATE TABLE condition_analysis_jobs (
 id bigserial PRIMARY KEY,
 inspection_id integer NOT NULL REFERENCES move_out_inspections(id) ON DELETE RESTRICT,
 input_version integer NOT NULL CHECK(input_version>0),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','superseded','cancelled')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 lease_token uuid,
 lease_until timestamptz,
 next_retry_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 failure_code text,
 model text,
 runtime_ms integer,
 usage jsonb,
 raw_output jsonb,
 prompt_version text,
 UNIQUE(inspection_id,input_version),
 CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX condition_analysis_jobs_claim ON condition_analysis_jobs(status,next_retry_at,lease_until);
ALTER TABLE condition_analysis_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON condition_analysis_jobs FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON condition_analysis_jobs FROM anon;
  REVOKE ALL ON SEQUENCE condition_analysis_jobs_id_seq FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON condition_analysis_jobs FROM authenticated;
  REVOKE ALL ON SEQUENCE condition_analysis_jobs_id_seq FROM authenticated;
 END IF;
END $$;
