-- Run in the Supabase project's SQL editor before deploying the document API.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('verification-documents', 'verification-documents', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO UPDATE SET public=false,
  file_size_limit=EXCLUDED.file_size_limit, allowed_mime_types=EXCLUDED.allowed_mime_types;

-- Nibash authorizes its own JWTs on the backend. Only the service role may
-- access this bucket directly, even if another permissive storage policy exists.
DROP POLICY IF EXISTS nibash_private_documents_backend_only ON storage.objects;
CREATE POLICY nibash_private_documents_backend_only ON storage.objects
AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (bucket_id <> 'verification-documents')
WITH CHECK (bucket_id <> 'verification-documents');
