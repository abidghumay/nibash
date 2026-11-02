BEGIN;

CREATE TABLE advance_allocations (
  id bigserial PRIMARY KEY,
  advance_event_id bigint NOT NULL REFERENCES payment_events(id) ON DELETE RESTRICT,
  rent_payment_id integer NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount numeric NOT NULL CHECK(amount>0),
  allocated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE advance_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON advance_allocations FROM PUBLIC;
CREATE TRIGGER rental_allocation_immutable BEFORE UPDATE OR DELETE ON advance_allocations FOR EACH ROW EXECUTE FUNCTION rental_immutable();

CREATE FUNCTION rental_received(p_payment integer) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(e.amount) FILTER(WHERE e.status='confirmed' AND r.id IS NULL),0)
  FROM payment_events e LEFT JOIN payment_reversals r ON r.event_id=e.id WHERE e.payment_id=p_payment;
$$;

CREATE FUNCTION rental_credited(p_payment integer) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(a.amount),0) FROM advance_allocations a
  LEFT JOIN payment_reversals r ON r.event_id=a.advance_event_id WHERE a.rent_payment_id=p_payment AND r.id IS NULL;
$$;
CREATE FUNCTION rental_outstanding(p_payment integer) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.status='confirmed' AND NOT EXISTS(SELECT 1 FROM payment_events WHERE payment_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM advance_allocations WHERE rent_payment_id=p.id) THEN 0
    ELSE greatest(0,p.amount-rental_received(p.id)-rental_credited(p.id)) END FROM payments p WHERE p.id=p_payment;
$$;
CREATE FUNCTION allocate_contract_advance(p_contract integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source record; target record; available numeric; allocation numeric; remaining numeric; root integer;
BEGIN
  SELECT coalesce(root_contract_id,id) INTO root FROM contracts WHERE id=p_contract;
  PERFORM 1 FROM contracts WHERE id=root FOR UPDATE;
  FOR source IN SELECT e.id,e.amount-coalesce((SELECT sum(a.amount) FROM advance_allocations a WHERE a.advance_event_id=e.id),0) AS available
    FROM payment_events e JOIN payments p ON p.id=e.payment_id JOIN contracts c ON c.id=p.contract_id LEFT JOIN payment_reversals r ON r.event_id=e.id
    WHERE coalesce(c.root_contract_id,c.id)=root AND p.category='advance' AND e.status='confirmed' AND r.id IS NULL ORDER BY e.id LOOP
    available:=source.available;
    FOR target IN SELECT p.id FROM payments p JOIN contracts c ON c.id=p.contract_id
      WHERE coalesce(c.root_contract_id,c.id)=root AND p.category='rent' AND p.status IN ('pending','overdue')
        AND NOT EXISTS(SELECT 1 FROM payment_events pending WHERE pending.payment_id=p.id AND pending.status='pending')
      ORDER BY p.billing_month NULLS LAST,p.id FOR UPDATE OF p LOOP
      EXIT WHEN available<=0;
      remaining:=rental_outstanding(target.id);allocation:=least(available,remaining);
      IF allocation>0 THEN
        INSERT INTO advance_allocations(advance_event_id,rent_payment_id,amount) VALUES(source.id,target.id,allocation);
        available:=available-allocation;
        IF rental_outstanding(target.id)=0 THEN UPDATE payments SET status='confirmed',paid_at=NULL WHERE id=target.id; END IF;
      END IF;
    END LOOP;
  END LOOP;
END; $$;
CREATE FUNCTION rental_allocate_on_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.category='rent' AND NEW.status IN ('pending','overdue') THEN PERFORM allocate_contract_advance(NEW.contract_id); END IF; RETURN NEW; END; $$;
CREATE TRIGGER rental_apply_advance AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION rental_allocate_on_invoice();

CREATE FUNCTION claim_rental_payment(p_actor integer,p_payment integer,p_amount numeric,p_method text,p_key text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; c contracts%ROWTYPE; existing payment_events%ROWTYPE; claim bigint; outstanding numeric;
BEGIN
  PERFORM 1 FROM contracts WHERE id=(SELECT coalesce(ctr.root_contract_id,ctr.id) FROM payments inv JOIN contracts ctr ON ctr.id=inv.contract_id WHERE inv.id=p_payment) FOR UPDATE;
  SELECT * INTO p FROM payments WHERE id=p_payment FOR UPDATE;
  SELECT * INTO c FROM contracts WHERE id=p.contract_id;
  IF NOT FOUND OR c.tenant_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Not authorized for this payment'; END IF;
  SELECT * INTO existing FROM payment_events WHERE payment_id=p.id AND request_key=p_key;
  IF FOUND THEN
    IF existing.amount IS DISTINCT FROM p_amount OR existing.method IS DISTINCT FROM p_method THEN RAISE EXCEPTION 'Idempotency key already used for a different payment claim'; END IF;
    RETURN existing.id;
  END IF;
  outstanding:=rental_outstanding(p.id);
  IF p.status NOT IN ('pending','overdue') OR p_amount IS NULL OR p_amount<=0 OR scale(p_amount)>2 OR p_amount>outstanding THEN
    RAISE EXCEPTION 'Payment amount must be positive, at most two decimals, and within the outstanding balance'; END IF;
  IF p_method NOT IN ('Cash','bKash','SSLCommerz') OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Payment method and request key required'; END IF;
  IF EXISTS(SELECT 1 FROM payment_events WHERE payment_id=p.id AND status='pending') THEN RAISE EXCEPTION 'A payment claim already awaits owner confirmation'; END IF;
  INSERT INTO payment_events(payment_id,amount,method,claimed_by,request_key) VALUES(p.id,p_amount,p_method,p_actor,p_key) RETURNING id INTO claim;
  UPDATE payments SET payment_method=p_method WHERE id=p.id;
  INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES(c.id,p_actor,'payment_claimed',jsonb_build_object('event_id',claim));
  RETURN claim;
END; $$;

CREATE FUNCTION confirm_rental_payment(p_actor integer,p_event bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE e payment_events%ROWTYPE; p payments%ROWTYPE; c contracts%ROWTYPE; snap jsonb; balance numeric; document bigint; landlord integer;
BEGIN
  SELECT * INTO e FROM payment_events WHERE id=p_event;
  PERFORM 1 FROM contracts WHERE id=(SELECT coalesce(ctr.root_contract_id,ctr.id) FROM payments inv JOIN contracts ctr ON ctr.id=inv.contract_id WHERE inv.id=e.payment_id) FOR UPDATE;
  SELECT * INTO p FROM payments WHERE id=e.payment_id FOR UPDATE;
  SELECT c0.* INTO c FROM contracts c0 JOIN listings l ON l.id=c0.listing_id WHERE c0.id=p.contract_id AND l.owner_id=p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized to confirm this payment'; END IF;
  SELECT * INTO e FROM payment_events WHERE id=p_event FOR UPDATE;
  IF e.status='confirmed' THEN SELECT id INTO document FROM rental_documents WHERE event_id=e.id; RETURN document; END IF;
  IF e.status<>'pending' THEN RAISE EXCEPTION 'Payment claim already resolved'; END IF;
  balance:=rental_outstanding(p.id)-e.amount;
  IF balance<0 THEN RAISE EXCEPTION 'Confirmation exceeds outstanding invoice'; END IF;
  UPDATE payment_events SET status='confirmed',confirmed_by=p_actor,confirmed_at=now() WHERE id=e.id;
  UPDATE payments SET status=CASE WHEN balance=0 THEN 'confirmed' ELSE CASE WHEN due_date<(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'overdue' ELSE 'pending' END END,
    paid_at=CASE WHEN balance=0 THEN now() AT TIME ZONE 'UTC' ELSE NULL END,payment_method=e.method WHERE id=p.id;
  PERFORM allocate_contract_advance(c.id);
  balance:=rental_outstanding(p.id);
  snap:=rental_contract_snapshot(c.id)||jsonb_build_object('payment_id',p.id,'event_id',e.id,'amount_received',e.amount::text,
    'outstanding_balance',balance::text,'category',p.category,'billing_month',p.billing_month,'payment_method',e.method,
    'confirmed_by',p_actor,'confirmed_at',now(),'issuer_name',(SELECT name FROM users WHERE id=p_actor),
    'confirmation','Authenticated landlord acknowledgment; no independent payment-provider verification',
    'document_label','Electronic payment acknowledgment');
  INSERT INTO rental_documents(contract_id,kind,version_key,event_id,owner_id,tenant_id,snapshot)
    VALUES(c.id,'acknowledgment','payment-event:'||e.id,e.id,p_actor,c.tenant_id,snap) RETURNING id INTO document;
  INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES(c.id,p_actor,'payment_confirmed',jsonb_build_object('event_id',e.id,'document_id',document));
  INSERT INTO notifications(user_id,contract_id,payment_id,kind,title,body,event_key)
    VALUES(c.tenant_id,c.id,p.id,'payment_installment','Payment installment received',
    format('The landlord acknowledged BDT %s. Outstanding on this invoice: BDT %s. An electronic acknowledgment is being prepared.',e.amount,balance),'installment:'||e.id);
  RETURN document;
END; $$;

CREATE FUNCTION reverse_rental_payment(p_actor integer,p_event bigint,p_reason text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE e payment_events%ROWTYPE; p payments%ROWTYPE; c contracts%ROWTYPE; reversal bigint; original rental_documents%ROWTYPE;
BEGIN
  SELECT * INTO e FROM payment_events WHERE id=p_event;
  PERFORM 1 FROM contracts WHERE id=(SELECT coalesce(ctr.root_contract_id,ctr.id) FROM payments inv JOIN contracts ctr ON ctr.id=inv.contract_id WHERE inv.id=e.payment_id) FOR UPDATE;
  SELECT * INTO p FROM payments WHERE id=e.payment_id FOR UPDATE;
  SELECT c0.* INTO c FROM contracts c0 JOIN listings l ON l.id=c0.listing_id WHERE c0.id=p.contract_id AND l.owner_id=p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authorized to reverse this payment'; END IF;
  IF e.status<>'confirmed' OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'A confirmed event and correction reason are required'; END IF;
  SELECT id INTO reversal FROM payment_reversals WHERE event_id=e.id;
  IF FOUND THEN RETURN reversal; END IF;
  INSERT INTO payment_reversals(event_id,actor_id,reason) VALUES(e.id,p_actor,p_reason) RETURNING id INTO reversal;
  UPDATE payments SET status='pending',paid_at=NULL WHERE id=p.id;
  UPDATE payments SET status='pending',paid_at=NULL WHERE id IN(SELECT rent_payment_id FROM advance_allocations WHERE advance_event_id=e.id);
  PERFORM allocate_contract_advance(c.id);
  SELECT * INTO original FROM rental_documents WHERE event_id=e.id;
  INSERT INTO rental_documents(contract_id,kind,version_key,reversal_id,owner_id,tenant_id,snapshot)
    VALUES(c.id,'reversal','reversal:'||reversal,reversal,p_actor,c.tenant_id,
      original.snapshot||jsonb_build_object('original_document_id',original.id,'original_event_id',e.id,'reversal_reason',p_reason,
        'reversed_at',now(),'reversed_by',p_actor,'outstanding_balance',rental_outstanding(p.id)::text));
  INSERT INTO rental_audit_events(contract_id,actor_id,kind,details) VALUES(c.id,p_actor,'payment_reversed',jsonb_build_object('event_id',e.id,'reversal_id',reversal));
  INSERT INTO notifications(user_id,contract_id,payment_id,kind,title,body,event_key)
    VALUES(c.tenant_id,c.id,p.id,'payment_installment','Payment correction recorded','An owner-recorded reversal is linked to the original acknowledgment. Review the payment history.','reversal:'||reversal);
  RETURN reversal;
END; $$;

CREATE FUNCTION rental_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'pending' OR (NEW.payment_id,NEW.amount,NEW.method,NEW.claimed_by,NEW.claimed_at,NEW.request_key)
    IS DISTINCT FROM (OLD.payment_id,OLD.amount,OLD.method,OLD.claimed_by,OLD.claimed_at,OLD.request_key) THEN
    RAISE EXCEPTION 'Confirmed payment events are immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_event_immutable BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION rental_event_guard();
CREATE FUNCTION rental_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment records must be retained'; END IF;
  IF OLD.status='confirmed' AND NEW.status<>'confirmed' AND NOT EXISTS(SELECT 1 FROM payment_events WHERE payment_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM advance_allocations WHERE rent_payment_id=OLD.id) THEN RAISE EXCEPTION 'Historical confirmed payment status is immutable'; END IF;
  IF (NEW.amount,NEW.contract_id,NEW.category,NEW.billing_month,NEW.due_date,NEW.billing_root_id) IS DISTINCT FROM
      (OLD.amount,OLD.contract_id,OLD.category,OLD.billing_month,OLD.due_date,OLD.billing_root_id) THEN
    RAISE EXCEPTION 'Issued invoice amounts and periods are immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER rental_invoice_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION rental_invoice_guard();

-- Compatibility read model: event receipts, plus original confirmed payments predating the ledger.
-- Reversed installments are excluded. A fully paid invoice is never counted a second time.
CREATE VIEW rental_income_payments AS
  SELECT p.id,p.contract_id,e.amount,e.method AS payment_method,'confirmed'::varchar AS status,
    p.billing_month,p.due_date,e.confirmed_at AT TIME ZONE 'UTC' AS paid_at,p.bkash_transaction_id,p.sslcommerz_transaction_id,e.id AS event_id,p.category
  FROM payments p JOIN payment_events e ON e.payment_id=p.id LEFT JOIN payment_reversals r ON r.event_id=e.id
  WHERE e.status='confirmed' AND r.id IS NULL
  UNION ALL
  SELECT p.id,p.contract_id,p.amount,p.payment_method,p.status,p.billing_month,p.due_date,p.paid_at,
    p.bkash_transaction_id,p.sslcommerz_transaction_id,NULL::bigint,p.category
  FROM payments p WHERE p.status='confirmed' AND NOT EXISTS(SELECT 1 FROM payment_events e WHERE e.payment_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM advance_allocations a WHERE a.rent_payment_id=p.id);

REVOKE ALL ON rental_income_payments FROM PUBLIC;
DO $$ DECLARE fn record; role_name text; seq text;
BEGIN
  FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND
    proname IN ('rental_received','rental_credited','rental_outstanding','allocate_contract_advance','rental_allocate_on_invoice','claim_rental_payment','confirm_rental_payment','reverse_rental_payment','rental_event_guard','rental_invoice_guard') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,role_name); END IF;
    END LOOP;
  END LOOP;
  FOREACH seq IN ARRAY ARRAY['advance_allocations_id_seq','rental_audit_events_id_seq','rent_revisions_id_seq','payment_events_id_seq','payment_reversals_id_seq','rental_documents_id_seq'] LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM PUBLIC',seq);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON SEQUENCE %I FROM %I',seq,role_name); END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON rental_income_payments,advance_allocations FROM %I',role_name);
    END IF;
  END LOOP;
END; $$;
COMMIT;
