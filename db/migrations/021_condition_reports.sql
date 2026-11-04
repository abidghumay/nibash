BEGIN;

CREATE TABLE condition_reports (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE RESTRICT,
  type text NOT NULL DEFAULT 'move_in' CHECK(type='move_in'),
  record_kind text NOT NULL CHECK(record_kind IN ('move_in','current_condition')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','confirmed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  locked_at timestamptz,
  integrity_hash text CHECK(integrity_hash ~ '^[a-f0-9]{64}$'),
  CHECK(owner_id<>tenant_id),
  CHECK((status='draft' AND integrity_hash IS NULL AND submitted_at IS NULL AND locked_at IS NULL)
    OR (status='submitted' AND integrity_hash IS NOT NULL AND submitted_at IS NOT NULL AND locked_at IS NULL)
    OR (status='confirmed' AND integrity_hash IS NOT NULL AND submitted_at IS NOT NULL AND locked_at IS NOT NULL))
);
CREATE TABLE condition_rooms (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES condition_reports(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  display_order integer NOT NULL CHECK(display_order>=0),
  UNIQUE(report_id,id),
  UNIQUE(report_id,display_order)
);
CREATE TABLE condition_photos (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES condition_reports(id) ON DELETE RESTRICT,
  room_id integer NOT NULL,
  storage_path text NOT NULL UNIQUE CHECK(storage_path ~ '^conditions/[0-9]+/[a-f0-9-]+[.](jpg|png)$'),
  original_filename text NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
  width integer NOT NULL CHECK(width BETWEEN 64 AND 8000),
  height integer NOT NULL CHECK(height BETWEEN 64 AND 8000),
  file_size integer NOT NULL CHECK(file_size BETWEEN 1 AND 8388608),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  uploaded_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY(report_id,room_id) REFERENCES condition_rooms(report_id,id) ON DELETE RESTRICT,
  CHECK(width::bigint*height<=24000000)
);
CREATE INDEX condition_photos_report ON condition_photos(report_id,id);
CREATE TABLE condition_events (
  id serial PRIMARY KEY,
  report_id integer NOT NULL REFERENCES condition_reports(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('created','room_added','photo_added','photo_updated','photo_removed','submitted','confirmed','ai_consent')),
  version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX condition_events_report ON condition_events(report_id,id);
CREATE UNIQUE INDEX condition_one_confirmation ON condition_events(report_id,version,actor_id) WHERE action='confirmed';
CREATE UNIQUE INDEX condition_one_submission ON condition_events(report_id,version) WHERE action='submitted';

CREATE FUNCTION condition_report_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Condition reports must be retained'; END IF;
  IF OLD.status='confirmed' THEN RAISE EXCEPTION 'Confirmed condition report is locked'; END IF;
  IF (NEW.id,NEW.contract_id,NEW.type,NEW.record_kind,NEW.created_by,NEW.owner_id,NEW.tenant_id,NEW.recorded_at)
    IS DISTINCT FROM (OLD.id,OLD.contract_id,OLD.type,OLD.record_kind,OLD.created_by,OLD.owner_id,OLD.tenant_id,OLD.recorded_at) THEN
    RAISE EXCEPTION 'Condition report identity is immutable';
  END IF;
  IF NEW.status='draft' AND (NEW.version<>OLD.version+1 OR NEW.integrity_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'Editing requires a new draft version';
  END IF;
  IF NEW.status IN ('submitted','confirmed') AND NEW.version<>OLD.version THEN
    RAISE EXCEPTION 'Submission version must not change';
  END IF;
  IF NEW.status='submitted' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'Only drafts can be submitted'; END IF;
  IF NEW.status='confirmed' AND (OLD.status<>'submitted' OR NEW.integrity_hash<>OLD.integrity_hash OR
    (SELECT count(DISTINCT actor_id) FROM condition_events e WHERE e.report_id=OLD.id AND e.version=OLD.version
      AND e.action='confirmed' AND e.actor_id IN (OLD.owner_id,OLD.tenant_id)
      AND e.details->>'hash'=OLD.integrity_hash)<>2) THEN
    RAISE EXCEPTION 'Both parties must confirm the submitted snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER condition_report_immutable BEFORE UPDATE OR DELETE ON condition_reports FOR EACH ROW EXECUTE FUNCTION condition_report_guard();

CREATE FUNCTION condition_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent condition_reports;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Condition evidence must be retained'; END IF;
  SELECT * INTO parent FROM condition_reports WHERE id=NEW.report_id FOR UPDATE;
  IF parent.status<>'draft' THEN RAISE EXCEPTION 'Submitted or confirmed evidence is locked'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='condition_rooms' THEN RAISE EXCEPTION 'Room records must be retained'; END IF;
    IF (to_jsonb(NEW)-'notes'-'removed_at') IS DISTINCT FROM (to_jsonb(OLD)-'notes'-'removed_at')
      OR OLD.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Original condition image is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER condition_rooms_guard BEFORE INSERT OR UPDATE OR DELETE ON condition_rooms FOR EACH ROW EXECUTE FUNCTION condition_evidence_guard();
CREATE TRIGGER condition_photos_guard BEFORE INSERT OR UPDATE OR DELETE ON condition_photos FOR EACH ROW EXECUTE FUNCTION condition_evidence_guard();

CREATE FUNCTION condition_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent condition_reports;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Condition audit events must be retained'; END IF;
  SELECT * INTO parent FROM condition_reports WHERE id=NEW.report_id FOR UPDATE;
  IF NEW.actor_id NOT IN (parent.owner_id,parent.tenant_id) OR NEW.version<>parent.version THEN
    RAISE EXCEPTION 'Event actor or version is invalid';
  END IF;
  IF NEW.action IN ('confirmed','ai_consent') AND (parent.status='draft' OR NEW.details->>'hash' IS DISTINCT FROM parent.integrity_hash) THEN
    RAISE EXCEPTION 'Event must reference the submitted snapshot hash';
  END IF;
  IF NEW.action='confirmed' AND parent.status<>'submitted' THEN RAISE EXCEPTION 'Report is locked'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER condition_event_immutable BEFORE INSERT OR UPDATE OR DELETE ON condition_events FOR EACH ROW EXECUTE FUNCTION condition_event_guard();

-- Extend the current allowed notification kinds rather than replacing its list.
DO $$
DECLARE prior text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior FROM pg_constraint
    WHERE conrelid='notifications'::regclass AND conname='notifications_kind_check';
  IF prior IS NOT NULL THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
    EXECUTE 'ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK ((' ||
      substring(prior FROM 8 FOR length(prior)-8) || ') OR kind=''condition_report'')';
  END IF;
END $$;

DO $$
DECLARE rel text; role_name text; fn text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['condition_reports','condition_rooms','condition_photos','condition_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',rel);
    EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM PUBLIC',rel||'_id_seq');
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',rel,role_name);
        EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I',rel||'_id_seq',role_name);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['condition_report_guard()','condition_evidence_guard()','condition_event_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
