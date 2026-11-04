BEGIN;
CREATE TABLE move_out_inspections (
  id serial PRIMARY KEY,
  contract_id integer NOT NULL UNIQUE REFERENCES contracts(id) ON DELETE RESTRICT,
  root_contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  baseline_report_id integer REFERENCES condition_reports(id) ON DELETE RESTRICT,
  baseline_version integer,
  baseline_hash text,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  status text NOT NULL DEFAULT 'awaiting_photos' CHECK(status IN ('awaiting_photos','analysis_pending','awaiting_inspection','needs_review','approved','completed')),
  input_hash text CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  analysis_result jsonb,
  analysis_source text CHECK(analysis_source IN ('live','manual')),
  approved_by integer REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  tenant_vacated_at timestamptz,
  move_out_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(owner_id<>tenant_id),
  CHECK((baseline_report_id IS NULL AND baseline_version IS NULL AND baseline_hash IS NULL) OR
    (baseline_report_id IS NOT NULL AND baseline_version>0 AND baseline_hash ~ '^[a-f0-9]{64}$')),
  CHECK((approved_at IS NULL AND approved_by IS NULL) OR (approved_at IS NOT NULL AND approved_by=owner_id)),
  CHECK(status<>'completed' OR (approved_at IS NOT NULL AND tenant_vacated_at IS NOT NULL AND move_out_date IS NOT NULL))
);
CREATE TABLE move_out_rooms (
  id serial PRIMARY KEY,
  inspection_id integer NOT NULL REFERENCES move_out_inspections(id) ON DELETE RESTRICT,
  baseline_room_id integer REFERENCES condition_rooms(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  display_order integer NOT NULL CHECK(display_order>=0),
  UNIQUE(inspection_id,id), UNIQUE(inspection_id,display_order)
);
CREATE TABLE move_out_photos (
  id serial PRIMARY KEY,
  inspection_id integer NOT NULL REFERENCES move_out_inspections(id) ON DELETE RESTRICT,
  room_id integer NOT NULL,
  baseline_photo_id integer REFERENCES condition_photos(id) ON DELETE RESTRICT,
  storage_path text NOT NULL UNIQUE CHECK(storage_path ~ '^conditions/[0-9]+/[a-f0-9-]+[.](jpg|png)$'),
  original_filename text NOT NULL CHECK(length(original_filename) BETWEEN 1 AND 200),
  mime_type text NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
  width integer NOT NULL CHECK(width BETWEEN 64 AND 8000), height integer NOT NULL CHECK(height BETWEEN 64 AND 8000),
  file_size integer NOT NULL CHECK(file_size BETWEEN 1 AND 8388608), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  notes text NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  uploaded_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  uploaded_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz,
  FOREIGN KEY(inspection_id,room_id) REFERENCES move_out_rooms(inspection_id,id) ON DELETE RESTRICT,
  CHECK(width::bigint*height<=24000000)
);
CREATE INDEX move_out_photos_inspection ON move_out_photos(inspection_id,id);
CREATE TABLE move_out_events (
  id serial PRIMARY KEY,
  inspection_id integer NOT NULL REFERENCES move_out_inspections(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX move_out_events_inspection ON move_out_events(inspection_id,id);
CREATE UNIQUE INDEX move_out_one_submission ON move_out_events(inspection_id,version) WHERE action='submitted';
CREATE UNIQUE INDEX move_out_one_approval ON move_out_events(inspection_id,version) WHERE action='approved';
CREATE UNIQUE INDEX move_out_one_completion ON move_out_events(inspection_id) WHERE action='completed';

CREATE FUNCTION move_out_inspection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Move-out inspections must be retained'; END IF;
  IF OLD.status='completed' THEN RAISE EXCEPTION 'Completed move-out inspection is locked'; END IF;
  IF (NEW.id,NEW.contract_id,NEW.root_contract_id,NEW.created_by,NEW.owner_id,NEW.tenant_id,NEW.baseline_report_id,NEW.baseline_version,NEW.baseline_hash,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.contract_id,OLD.root_contract_id,OLD.created_by,OLD.owner_id,OLD.tenant_id,OLD.baseline_report_id,OLD.baseline_version,OLD.baseline_hash,OLD.created_at)
    THEN RAISE EXCEPTION 'Inspection identity and baseline are immutable'; END IF;
  IF NEW.version<>OLD.version AND (NEW.version<>OLD.version+1 OR NEW.status<>'awaiting_photos' OR NEW.input_hash IS NOT NULL OR NEW.analysis_result IS NOT NULL OR NEW.approved_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Evidence edits require a new unapproved input version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER move_out_inspection_immutable BEFORE UPDATE OR DELETE ON move_out_inspections FOR EACH ROW EXECUTE FUNCTION move_out_inspection_guard();
CREATE FUNCTION move_out_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent move_out_inspections;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Move-out evidence must be retained'; END IF;
  SELECT * INTO parent FROM move_out_inspections WHERE id=NEW.inspection_id FOR UPDATE;
  IF parent.status<>'awaiting_photos' THEN RAISE EXCEPTION 'Submitted or completed evidence is locked'; END IF;
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='move_out_rooms' OR (to_jsonb(NEW)-'removed_at') IS DISTINCT FROM (to_jsonb(OLD)-'removed_at') OR OLD.removed_at IS NOT NULL
      THEN RAISE EXCEPTION 'Original move-out evidence is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER move_out_rooms_immutable BEFORE INSERT OR UPDATE OR DELETE ON move_out_rooms FOR EACH ROW EXECUTE FUNCTION move_out_evidence_guard();
CREATE TRIGGER move_out_photos_immutable BEFORE INSERT OR UPDATE OR DELETE ON move_out_photos FOR EACH ROW EXECUTE FUNCTION move_out_evidence_guard();
CREATE FUNCTION move_out_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent move_out_inspections;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Move-out audit events must be retained'; END IF;
  SELECT * INTO parent FROM move_out_inspections WHERE id=NEW.inspection_id FOR UPDATE;
  IF NEW.actor_id NOT IN (parent.owner_id,parent.tenant_id) OR NEW.version<>parent.version THEN RAISE EXCEPTION 'Invalid move-out audit actor or version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER move_out_events_immutable BEFORE INSERT OR UPDATE OR DELETE ON move_out_events FOR EACH ROW EXECUTE FUNCTION move_out_event_guard();
DO $$ DECLARE rel text; role_name text; fn text;
BEGIN
  FOREACH rel IN ARRAY ARRAY['move_out_inspections','move_out_rooms','move_out_photos','move_out_events'] LOOP
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
  FOREACH fn IN ARRAY ARRAY['move_out_inspection_guard()','move_out_evidence_guard()','move_out_event_guard()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn,role_name);
      END IF;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
