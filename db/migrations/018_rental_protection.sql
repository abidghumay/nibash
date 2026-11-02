-- Hackathon rental-management extension. Additive; never replay migrations 001–004 on live data.
BEGIN;

ALTER TABLE terms ADD COLUMN advance_rent numeric NOT NULL DEFAULT 0;
ALTER TABLE contracts
  ADD COLUMN previous_contract_id integer UNIQUE REFERENCES contracts(id),
  ADD COLUMN root_contract_id integer REFERENCES contracts(id),
  ADD COLUMN initial_rent numeric,
  ADD COLUMN tenancy_started_on date,
  ADD COLUMN protection_until date,
  ADD COLUMN protection_state text NOT NULL DEFAULT 'needs_verification'
    CHECK(protection_state IN ('needs_verification','awaiting_acceptance','verified')),
  ADD COLUMN created_by_id integer REFERENCES users(id),
  ADD COLUMN proposed_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN occupancy_state text NOT NULL DEFAULT 'unconfirmed'
    CHECK(occupancy_state IN ('unconfirmed','upcoming','occupied','move_out_pending','closed','continued')),
  ADD COLUMN move_out_date date,
  ADD COLUMN owner_closed_at timestamptz,
  ADD COLUMN tenant_closed_at timestamptz,
  ADD COLUMN inspection_note text,
  ADD COLUMN settlement_note text;
ALTER TABLE contracts DROP CONSTRAINT contracts_status_check;
ALTER TABLE contracts ADD CONSTRAINT contracts_status_check CHECK(status IN ('proposed','signed','completed','renewed'));

CREATE TABLE rental_audit_events (
  id bigserial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  actor_id integer REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rent_revisions (
  id bigserial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  root_contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  previous_rent numeric NOT NULL,
  proposed_rent numeric NOT NULL CHECK(proposed_rent>0 AND scale(proposed_rent)<=2),
  effective_on date NOT NULL,
  proposed_by integer NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected')),
  reviewed_by integer REFERENCES users(id),
  reviewed_at timestamptz,
  UNIQUE(root_contract_id,effective_on)
);
CREATE UNIQUE INDEX rental_one_pending_revision ON rent_revisions(root_contract_id) WHERE status='proposed';

ALTER TABLE payments ADD COLUMN category text NOT NULL DEFAULT 'historical'
  CHECK(category IN ('rent','advance','historical'));
ALTER TABLE payments ALTER COLUMN category SET DEFAULT 'rent';
ALTER TABLE payments ADD COLUMN billing_root_id integer REFERENCES contracts(id) ON DELETE RESTRICT;
UPDATE payments p SET billing_root_id=coalesce(c.root_contract_id,c.id) FROM contracts c WHERE c.id=p.contract_id;
CREATE UNIQUE INDEX rental_one_invoice_per_root_month ON payments(billing_root_id,billing_month);
CREATE FUNCTION rental_invoice_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT coalesce(root_contract_id,id) INTO NEW.billing_root_id FROM contracts WHERE id=NEW.contract_id;
  PERFORM 1 FROM contracts WHERE id=NEW.billing_root_id FOR UPDATE;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_invoice_continuity BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION rental_invoice_root();
CREATE TABLE payment_events (
  id bigserial PRIMARY KEY,
  payment_id integer NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK(amount>0 AND scale(amount)<=2),
  method text NOT NULL CHECK(method IN ('Cash','bKash','SSLCommerz')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
  claimed_by integer NOT NULL REFERENCES users(id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by integer REFERENCES users(id),
  confirmed_at timestamptz,
  request_key text NOT NULL,
  UNIQUE(payment_id,request_key)
);
CREATE UNIQUE INDEX rental_one_pending_claim ON payment_events(payment_id) WHERE status='pending';
CREATE TABLE payment_reversals (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL UNIQUE REFERENCES payment_events(id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rental_documents (
  id bigserial PRIMARY KEY,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('draft','agreement','amendment','acknowledgment','reversal')),
  version_key text NOT NULL UNIQUE,
  event_id bigint UNIQUE REFERENCES payment_events(id) ON DELETE RESTRICT,
  reversal_id bigint UNIQUE REFERENCES payment_reversals(id) ON DELETE RESTRICT,
  revision_id bigint UNIQUE REFERENCES rent_revisions(id) ON DELETE RESTRICT,
  owner_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  pdf_bytes bytea,
  pdf_sha256 text,
  snapshot_sha256 text,
  generated_at timestamptz
);
CREATE INDEX rental_document_work ON rental_documents(state,retry_at);
CREATE INDEX rental_document_history ON rental_documents(contract_id,id DESC);
CREATE TABLE dmp_preparation (
  contract_id integer PRIMARY KEY REFERENCES contracts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('not_prepared','prepared','submitted_manually_unverified')),
  submission_date date,
  self_reported_reference varchar(120),
  updated_by integer NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(status='submitted_manually_unverified' OR (submission_date IS NULL AND self_reported_reference IS NULL))
);

CREATE FUNCTION rental_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'This audit or financial record is immutable; use a linked correction'; END; $$;
CREATE TRIGGER rental_audit_immutable BEFORE UPDATE OR DELETE ON rental_audit_events FOR EACH ROW EXECUTE FUNCTION rental_immutable();
CREATE TRIGGER rental_reversal_immutable BEFORE UPDATE OR DELETE ON payment_reversals FOR EACH ROW EXECUTE FUNCTION rental_immutable();

CREATE FUNCTION rental_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM contracts WHERE agreement_id=OLD.id) THEN RAISE EXCEPTION 'Agreement terms are immutable and must be retained'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM contracts WHERE agreement_id=OLD.id) THEN
    RAISE EXCEPTION 'Proposed and signed agreement terms are immutable; propose a versioned rent revision';
  END IF;
  IF coalesce(NEW.security_deposit,0)<>0 THEN
    RAISE EXCEPTION 'New security deposit collection is unsupported under Section 10; historical deposits remain accounting records';
  END IF;
  IF NEW.advance_rent<0 OR NEW.advance_rent>coalesce(NEW.rent,0) THEN
    RAISE EXCEPTION 'Advance rent above one month requires prior approval from the Rent Controller under Section 10; exceptional collection is unsupported';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_terms_protection BEFORE INSERT OR UPDATE OR DELETE ON terms FOR EACH ROW EXECUTE FUNCTION rental_terms_guard();
CREATE TRIGGER rental_contract_retention BEFORE DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION rental_immutable();

CREATE FUNCTION effective_contract_rent(p_contract integer,p_on date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT r.proposed_rent FROM rent_revisions r
    WHERE r.root_contract_id=coalesce(c.root_contract_id,c.id) AND r.status='accepted' AND r.effective_on<=p_on
    ORDER BY r.effective_on DESC,r.id DESC LIMIT 1),c.initial_rent,t.rent)
  FROM contracts c JOIN terms t ON t.id=c.agreement_id WHERE c.id=p_contract;
$$;

CREATE FUNCTION rental_contract_snapshot(p_contract integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('contract_id',c.id,'listing_id',l.id,'property',l.title,
    'address',concat_ws(', ', 'Floor '||l.on_which_floor,a.name,a.city),
    'owner_name',uo.name,'tenant_name',ut.name,'owner_id',l.owner_id,'tenant_id',c.tenant_id,
    'start_date',c.start_date,'end_date',c.end_date,'monthly_rent',t.rent::text,
    'electricity_bill',coalesce(t.electricity_bill,0)::text,'water_bill',coalesce(t.water_bill,0)::text,
    'service_charge',coalesce(t.service_charge,0)::text,'monthly_due_date',t.monthly_due_date,
    'pet_allowed',t.pet_allowed,'advance_rent',t.advance_rent::text,
    'historical_deposit',coalesce(t.security_deposit,0)::text,'initial_rent',c.initial_rent::text,
    'tenancy_started_on',c.tenancy_started_on,'protection_until',c.protection_until,
    'protection_state',c.protection_state,'owner_proposed_at',c.proposed_at,'tenant_accepted_at',c.accepted_at,
    'currency','BDT','policy_version','NIBASH-24M-v1',
    'attribution','Authenticated account actions; no certified digital signature or lease registration asserted')
  FROM contracts c JOIN listings l ON l.id=c.listing_id JOIN areas a ON a.id=l.area_id
    JOIN terms t ON t.id=c.agreement_id JOIN users uo ON uo.id=l.owner_id JOIN users ut ON ut.id=c.tenant_id WHERE c.id=p_contract;
$$;

CREATE FUNCTION rental_contract_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior contracts%ROWTYPE; tr terms%ROWTYPE; oldterms terms%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM listings WHERE id=NEW.listing_id FOR UPDATE;
    SELECT * INTO tr FROM terms WHERE id=NEW.agreement_id FOR UPDATE;
    IF NEW.status<>'proposed' THEN RAISE EXCEPTION 'New contracts require a proposal and tenant acceptance'; END IF;
    IF coalesce(tr.security_deposit,0)<>0 OR tr.advance_rent>tr.rent THEN RAISE EXCEPTION 'Deposit or advance violates ordinary residential policy'; END IF;
    IF NEW.end_date<=NEW.start_date THEN RAISE EXCEPTION 'End date must follow the effective start'; END IF;
    IF NEW.previous_contract_id IS NOT NULL THEN
      SELECT * INTO prior FROM contracts WHERE id=NEW.previous_contract_id FOR UPDATE;
      IF NOT FOUND OR prior.listing_id<>NEW.listing_id OR prior.tenant_id<>NEW.tenant_id
        OR prior.status<>'signed' OR prior.occupancy_state='closed' OR NEW.start_date<>prior.end_date+1 THEN
        RAISE EXCEPTION 'Renewal must continue the same tenant and listing on the next calendar day';
      END IF;
      IF prior.protection_state<>'verified' THEN RAISE EXCEPTION 'Historical tenancy requires verification before renewal'; END IF;
      SELECT * INTO oldterms FROM terms WHERE id=prior.agreement_id;
      IF tr.rent<>effective_contract_rent(prior.id,NEW.start_date)
        OR coalesce(tr.service_charge,0)<>coalesce(oldterms.service_charge,0)
        OR coalesce(tr.electricity_bill,0)<>coalesce(oldterms.electricity_bill,0)
        OR coalesce(tr.water_bill,0)<>coalesce(oldterms.water_bill,0)
        OR tr.advance_rent<>0 THEN
        RAISE EXCEPTION 'Renewal cannot bypass protected rent or introduce mandatory charges; use an accepted revision';
      END IF;
      NEW.root_contract_id:=coalesce(prior.root_contract_id,prior.id);
    ELSE
      IF EXISTS(SELECT 1 FROM contracts WHERE listing_id=NEW.listing_id AND (status IN ('proposed','signed') OR occupancy_state<>'closed')) THEN
        RAISE EXCEPTION 'An open contract or unverified continuing occupancy exists; use a continuing renewal or confirm move-out';
      END IF;
      NEW.root_contract_id:=NEW.id;
    END IF;
    IF EXISTS(SELECT 1 FROM contracts WHERE listing_id=NEW.listing_id AND status='proposed') THEN RAISE EXCEPTION 'An open contract proposal already exists'; END IF;
    NEW.protection_state:='awaiting_acceptance'; NEW.proposed_at:=now(); NEW.occupancy_state:='upcoming';
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT
      ((OLD.status='proposed' AND NEW.status='signed') OR (OLD.status='signed' AND NEW.status IN ('completed','renewed'))) THEN
      RAISE EXCEPTION 'Invalid contract status transition; accepted history is immutable';
    END IF;
    IF OLD.status='proposed' AND (NEW.agreement_id,NEW.start_date,NEW.end_date,NEW.tenant_id,NEW.listing_id,NEW.previous_contract_id,NEW.created_by_id,NEW.proposed_at,NEW.root_contract_id)
      IS DISTINCT FROM (OLD.agreement_id,OLD.start_date,OLD.end_date,OLD.tenant_id,OLD.listing_id,OLD.previous_contract_id,OLD.created_by_id,OLD.proposed_at,OLD.root_contract_id) THEN
      RAISE EXCEPTION 'Proposal terms are immutable; create a reviewed proposal instead';
    END IF;
    IF OLD.status<>'proposed' AND (NEW.agreement_id,NEW.start_date,NEW.end_date,NEW.tenant_id,NEW.listing_id,
      NEW.root_contract_id,NEW.initial_rent,NEW.tenancy_started_on,NEW.protection_until,NEW.protection_state,NEW.accepted_at,
      NEW.previous_contract_id,NEW.created_by_id,NEW.proposed_at)
      IS DISTINCT FROM (OLD.agreement_id,OLD.start_date,OLD.end_date,OLD.tenant_id,OLD.listing_id,
      OLD.root_contract_id,OLD.initial_rent,OLD.tenancy_started_on,OLD.protection_until,OLD.protection_state,OLD.accepted_at,
      OLD.previous_contract_id,OLD.created_by_id,OLD.proposed_at) THEN
      RAISE EXCEPTION 'Signed agreement and rent protection history are immutable';
    END IF;
    IF NEW.status='signed' AND OLD.status='proposed' THEN
      IF OLD.protection_state<>'awaiting_acceptance' OR OLD.created_by_id IS NULL THEN
        RAISE EXCEPTION 'Historical proposal requires verified terms before acceptance';
      END IF;
      SELECT * INTO tr FROM terms WHERE id=NEW.agreement_id;
      IF coalesce(tr.security_deposit,0)<>0 OR tr.advance_rent>tr.rent THEN RAISE EXCEPTION 'Deposit or advance violates ordinary residential policy'; END IF;
      NEW.accepted_at:=now(); NEW.protection_state:='verified';
      IF NEW.previous_contract_id IS NOT NULL THEN
        SELECT * INTO prior FROM contracts WHERE id=NEW.previous_contract_id FOR UPDATE;
        IF prior.status<>'signed' OR prior.occupancy_state='closed' THEN RAISE EXCEPTION 'Continuing tenancy is no longer available'; END IF;
        NEW.initial_rent:=prior.initial_rent; NEW.tenancy_started_on:=prior.tenancy_started_on;
        NEW.protection_until:=prior.protection_until;
        UPDATE contracts SET status='renewed',occupancy_state='continued' WHERE id=prior.id;
      ELSE
        NEW.initial_rent:=tr.rent; NEW.tenancy_started_on:=NEW.start_date;
        NEW.protection_until:=(NEW.start_date+interval '24 months')::date;
      END IF;
      NEW.occupancy_state:=CASE WHEN NEW.start_date>(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'upcoming' ELSE 'occupied' END;
    END IF;
    IF NEW.status='completed' AND OLD.status<>'completed' AND
      (NEW.owner_closed_at IS NULL OR NEW.tenant_closed_at IS NULL OR NEW.move_out_date IS NULL OR NEW.occupancy_state<>'closed'
      OR NEW.inspection_note IS NULL OR NEW.settlement_note IS NULL) THEN
      RAISE EXCEPTION 'Final closure requires both parties, move-out, inspection and settlement; expiry does not imply vacancy';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_contract_protection BEFORE INSERT OR UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION rental_contract_guard();

CREATE OR REPLACE FUNCTION update_listing_status_completed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND NEW.occupancy_state='closed' AND NEW.owner_closed_at IS NOT NULL AND NEW.tenant_closed_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM contracts WHERE listing_id=NEW.listing_id AND id<>NEW.id AND status IN ('proposed','signed')) THEN
    UPDATE listings SET status='approved' WHERE id=NEW.listing_id;
  END IF; RETURN NEW;
END; $$;

CREATE FUNCTION rental_agreement_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snap jsonb;
BEGIN
  IF TG_OP='INSERT' OR (NEW.status='signed' AND OLD.status='proposed') THEN
    snap:=rental_contract_snapshot(NEW.id);
    INSERT INTO rental_documents(contract_id,kind,version_key,owner_id,tenant_id,snapshot)
      VALUES(NEW.id,CASE WHEN NEW.status='proposed' THEN 'draft' ELSE 'agreement' END,
      'contract:'||NEW.id||':'||NEW.status,(snap->>'owner_id')::int,NEW.tenant_id,snap);
    INSERT INTO rental_audit_events(contract_id,actor_id,kind)
      VALUES(NEW.id,CASE WHEN NEW.status='proposed' THEN NEW.created_by_id ELSE NEW.tenant_id END,
        CASE WHEN NEW.status='proposed' THEN 'owner_proposed' ELSE 'tenant_accepted' END);
    IF NEW.status='signed' AND (snap->>'advance_rent')::numeric>0 THEN
      INSERT INTO payments(contract_id,amount,category,status) VALUES(NEW.id,(snap->>'advance_rent')::numeric,'advance','pending');
    END IF;
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER rental_agreement_snapshots AFTER INSERT OR UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION rental_agreement_document();

CREATE FUNCTION propose_rent_revision(p_actor integer,p_contract integer,p_rent numeric,p_on date) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE c contracts%ROWTYPE; revision bigint; previous numeric;
BEGIN
  SELECT c0.* INTO c FROM contracts c0 JOIN listings l ON l.id=c0.listing_id WHERE c0.id=p_contract AND l.owner_id=p_actor FOR UPDATE OF c0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized for this contract'; END IF;
  IF c.status<>'signed' OR c.protection_state<>'verified' OR c.occupancy_state IN ('closed','move_out_pending') THEN RAISE EXCEPTION 'Signed continuing tenancy with verified history required'; END IF;
  IF p_rent IS NULL OR p_rent<=0 OR scale(p_rent)>2 OR p_on IS NULL OR p_on<c.start_date OR p_on<(now() AT TIME ZONE 'Asia/Dhaka')::date THEN
    RAISE EXCEPTION 'A positive rent with at most two decimal places and a future effective date is required'; END IF;
  previous:=effective_contract_rent(c.id,p_on);
  IF p_rent=previous THEN RAISE EXCEPTION 'Proposed rent must differ from effective rent'; END IF;
  IF p_rent>previous AND p_on<c.protection_until THEN
    RAISE EXCEPTION 'Your agreement is protected under Nibash''s 24-month rent policy until %. A rent increase cannot take effect before that date.',to_char(c.protection_until,'FMMonth DD, YYYY'); END IF;
  IF EXISTS(SELECT 1 FROM rent_revisions WHERE root_contract_id=c.root_contract_id AND status IN ('accepted','proposed') AND effective_on>=p_on) THEN
    RAISE EXCEPTION 'A pending or later amendment exists; revisions must be reviewed in chronological order'; END IF;
  INSERT INTO rent_revisions(contract_id,root_contract_id,previous_rent,proposed_rent,effective_on,proposed_by)
    VALUES(c.id,c.root_contract_id,previous,p_rent,p_on,p_actor) RETURNING id INTO revision;
  INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES(c.id,p_actor,'rent_revision_proposed',jsonb_build_object('revision_id',revision));
  INSERT INTO notifications(user_id,contract_id,kind,title,body,event_key)
    VALUES(c.tenant_id,c.id,'rent_revision','Rent revision needs your review','Review the proposed rent and effective date. Acceptance is optional.','revision:'||revision);
  RETURN revision;
END; $$;

CREATE FUNCTION accept_rent_revision(p_actor integer,p_revision bigint,p_accept boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r rent_revisions%ROWTYPE; c contracts%ROWTYPE; snap jsonb;
BEGIN
  SELECT * INTO r FROM rent_revisions WHERE id=p_revision;
  SELECT * INTO c FROM contracts WHERE id=r.contract_id FOR UPDATE;
  IF c.tenant_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Not authorized for this amendment'; END IF;
  SELECT * INTO r FROM rent_revisions WHERE id=p_revision FOR UPDATE;
  IF r.status<>'proposed' THEN RAISE EXCEPTION 'Amendment already reviewed'; END IF;
  IF c.status NOT IN ('signed','renewed') OR c.protection_state<>'verified' OR c.occupancy_state='closed' THEN RAISE EXCEPTION 'Current verified agreement required'; END IF;
  IF p_accept AND (r.effective_on<(now() AT TIME ZONE 'Asia/Dhaka')::date OR
    (r.proposed_rent>effective_contract_rent(c.id,r.effective_on) AND r.effective_on<c.protection_until)) THEN
    RAISE EXCEPTION 'Amendment effective date violates the 24-month policy or is in the past'; END IF;
  UPDATE rent_revisions SET status=CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,reviewed_by=p_actor,reviewed_at=now() WHERE id=r.id;
  INSERT INTO rental_audit_events(contract_id,actor_id,kind,details)
    VALUES(c.id,p_actor,CASE WHEN p_accept THEN 'rent_revision_accepted' ELSE 'rent_revision_rejected' END,jsonb_build_object('revision_id',r.id));
  IF p_accept THEN
    snap:=rental_contract_snapshot(c.id)||jsonb_build_object('previous_rent',r.previous_rent::text,'revised_rent',r.proposed_rent::text,
      'effective_on',r.effective_on,'revision_id',r.id,'proposed_by',r.proposed_by,'proposed_at',r.proposed_at,'accepted_by',p_actor,'accepted_at',now());
    INSERT INTO rental_documents(contract_id,kind,version_key,revision_id,owner_id,tenant_id,snapshot)
      VALUES(c.id,'amendment','revision:'||r.id,r.id,(snap->>'owner_id')::int,c.tenant_id,snap);
  END IF;
END; $$;

CREATE FUNCTION rental_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'proposed' OR (NEW.contract_id,NEW.root_contract_id,NEW.previous_rent,NEW.proposed_rent,NEW.effective_on,NEW.proposed_by,NEW.proposed_at)
    IS DISTINCT FROM (OLD.contract_id,OLD.root_contract_id,OLD.previous_rent,OLD.proposed_rent,OLD.effective_on,OLD.proposed_by,OLD.proposed_at) THEN
    RAISE EXCEPTION 'Amendment history is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_revision_immutable BEFORE UPDATE OR DELETE ON rent_revisions FOR EACH ROW EXECUTE FUNCTION rental_revision_guard();

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('payment_created','payment_confirmed','payment_rejected',
  'contract_proposed','contract_signed','contract_completed','contract_expiring','rent_revision','tenant_correction','payment_installment','move_out'));

CREATE FUNCTION rental_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original rental documents must be retained'; END IF;
  IF OLD.state='ready' OR (NEW.contract_id,NEW.kind,NEW.version_key,NEW.owner_id,NEW.tenant_id,NEW.snapshot,NEW.issued_at,NEW.event_id,NEW.reversal_id,NEW.revision_id)
    IS DISTINCT FROM (OLD.contract_id,OLD.kind,OLD.version_key,OLD.owner_id,OLD.tenant_id,OLD.snapshot,OLD.issued_at,OLD.event_id,OLD.reversal_id,OLD.revision_id) THEN
    RAISE EXCEPTION 'Issued document snapshot is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_document_immutable BEFORE UPDATE OR DELETE ON rental_documents FOR EACH ROW EXECUTE FUNCTION rental_document_guard();

CREATE OR REPLACE PROCEDURE generate_monthly_payments() LANGUAGE plpgsql AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Dhaka')::date;
BEGIN
  INSERT INTO payments(contract_id,amount,status,billing_month,due_date)
  SELECT c.id,effective_contract_rent(c.id,today)
    +coalesce(t.electricity_bill,0)+coalesce(t.water_bill,0)+coalesce(t.service_charge,0),
    'pending',date_trunc('month',today)::date,
    greatest(c.start_date,(date_trunc('month',today)+(least(t.monthly_due_date,28)-1)*interval '1 day')::date)
  FROM contracts c JOIN terms t ON t.id=c.agreement_id
  WHERE c.status IN ('signed','renewed') AND today>=c.start_date AND c.occupancy_state<>'closed'
    AND (c.end_date>=today OR c.occupancy_state IN ('occupied','move_out_pending'))
    AND NOT EXISTS(SELECT 1 FROM contracts successor WHERE successor.previous_contract_id=c.id AND successor.status='signed' AND successor.start_date<=today)
  ORDER BY coalesce(c.root_contract_id,c.id),c.id
  ON CONFLICT DO NOTHING;
END; $$;

-- The API uses its server-side connection. Browser Supabase roles cannot bypass JWT checks.
DO $$ DECLARE rel text; role_name text; fn record;
BEGIN
  FOREACH rel IN ARRAY ARRAY['rental_audit_events','rent_revisions','payment_events','payment_reversals','rental_documents','dmp_preparation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC',rel);
  END LOOP;
  FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND
    (proname LIKE 'rental_%' OR proname IN ('effective_contract_rent','propose_rent_revision','accept_rent_revision')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      FOREACH rel IN ARRAY ARRAY['contracts','terms','agreements','payments','rental_audit_events','rent_revisions','payment_events','payment_reversals','rental_documents','dmp_preparation'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',rel,role_name);
      END LOOP;
      FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND
        (proname LIKE 'rental_%' OR proname IN ('effective_contract_rent','propose_rent_revision','accept_rent_revision')) LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,role_name);
      END LOOP;
    END IF;
  END LOOP;
END; $$;
COMMIT;
