-- Run separately in Supabase SQL editor after reviewing deployment configuration.
-- No browser upload/read policies: only the backend service role touches this bucket.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('condition-evidence','condition-evidence',false,8388608,ARRAY['image/jpeg','image/png'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=8388608,allowed_mime_types=ARRAY['image/jpeg','image/png'];
-- Existing broad storage.objects policies must not grant browser access to this bucket.
-- Restrictive policies also block a pre-existing permissive "all buckets" policy.
DROP POLICY IF EXISTS condition_no_browser_read ON storage.objects;
DROP POLICY IF EXISTS condition_no_browser_insert ON storage.objects;
DROP POLICY IF EXISTS condition_no_browser_update ON storage.objects;
DROP POLICY IF EXISTS condition_no_browser_delete ON storage.objects;
CREATE POLICY condition_no_browser_read ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
USING(bucket_id<>'condition-evidence');
CREATE POLICY condition_no_browser_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
WITH CHECK(bucket_id<>'condition-evidence');
CREATE POLICY condition_no_browser_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
USING(bucket_id<>'condition-evidence') WITH CHECK(bucket_id<>'condition-evidence');
CREATE POLICY condition_no_browser_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated
USING(bucket_id<>'condition-evidence');
COMMIT;
