BEGIN;
-- Opt-in synthetic contracts only; no public API can register a contract here.
CREATE TABLE sandbox_contracts (
  contract_id integer PRIMARY KEY REFERENCES contracts(id) ON DELETE RESTRICT,
  label text NOT NULL DEFAULT 'TEST — no real money transferred'
);
CREATE TABLE payment_attempts (
  id text PRIMARY KEY,
  payment_id integer NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  tenant_id integer NOT NULL REFERENCES users(id),
  provider text NOT NULL DEFAULT 'shurjopay-sandbox' CHECK(provider IN ('shurjopay-sandbox','simulated')),
  merchant_order_id text NOT NULL UNIQUE,
  provider_order_id text UNIQUE,
  amount numeric NOT NULL CHECK(amount>0 AND scale(amount)<=2),
  currency text NOT NULL DEFAULT 'BDT' CHECK(currency='BDT'),
  state text NOT NULL DEFAULT 'initiating' CHECK(state IN ('initiating','pending','succeeded','failed','cancelled','review')),
  checkout_url text,
  event_id bigint UNIQUE REFERENCES payment_events(id),
  verification jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
  retry_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token text,
  checks integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_unresolved_online_attempt ON payment_attempts(payment_id) WHERE state IN ('initiating','pending','review');
CREATE INDEX sandbox_attempt_work ON payment_attempts(retry_at) WHERE state='pending';
CREATE TABLE simulated_provider_transactions (
  attempt_id text PRIMARY KEY REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  provider_order_id text NOT NULL UNIQUE,
  outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','succeeded','failed','cancelled')),
  available_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments DROP CONSTRAINT payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check CHECK(payment_method IN ('Cash','bKash','SSLCommerz','shurjoPay TEST','Simulated TEST'));
ALTER TABLE payment_events DROP CONSTRAINT payment_events_method_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_method_check CHECK(method IN ('Cash','bKash','SSLCommerz','shurjoPay TEST','Simulated TEST'));

CREATE FUNCTION confirm_sandbox_payment(p_attempt text, v jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE a payment_attempts%ROWTYPE; p payments%ROWTYPE; c contracts%ROWTYPE; landlord integer; ev bigint; doc bigint; balance numeric; snap jsonb; method text; confirmation text;
BEGIN
  -- Same lock order as manual confirmation: tenancy root, invoice, then attempt.
  PERFORM 1 FROM contracts WHERE id=(SELECT coalesce(c0.root_contract_id,c0.id) FROM payment_attempts a0
    JOIN payments p0 ON p0.id=a0.payment_id JOIN contracts c0 ON c0.id=p0.contract_id WHERE a0.id=p_attempt) FOR UPDATE;
  SELECT p0.* INTO p FROM payments p0 JOIN payment_attempts a0 ON a0.payment_id=p0.id WHERE a0.id=p_attempt FOR UPDATE OF p0;
  SELECT * INTO a FROM payment_attempts WHERE id=p_attempt FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown payment attempt'; END IF;
  SELECT * INTO c FROM contracts WHERE id=p.contract_id;
  IF NOT EXISTS(SELECT 1 FROM sandbox_contracts WHERE contract_id=c.id) OR c.tenant_id<>a.tenant_id OR a.provider NOT IN ('shurjopay-sandbox','simulated')
    THEN RAISE EXCEPTION 'Not an authorized synthetic payment'; END IF;
  IF v->>'order_id' IS DISTINCT FROM a.provider_order_id OR a.provider_order_id IS NULL
    OR v->>'customer_order_id' IS DISTINCT FROM a.merchant_order_id OR v->>'currency' IS DISTINCT FROM 'BDT'
    OR v->>'value1' IS DISTINCT FROM p.id::text OR v->>'value2' IS DISTINCT FROM a.id
    OR v->>'sp_code' IS DISTINCT FROM '1000' OR (v->>'amount')::numeric IS DISTINCT FROM a.amount
    THEN RAISE EXCEPTION 'Provider verification mismatch'; END IF;
  IF a.state='succeeded' THEN SELECT id INTO doc FROM rental_documents WHERE event_id=a.event_id; RETURN doc; END IF;
  IF a.state NOT IN ('pending','review') OR p.status NOT IN ('pending','overdue') OR a.amount>rental_outstanding(p.id)
    OR EXISTS(SELECT 1 FROM payment_events WHERE payment_id=p.id AND status='pending')
    THEN RAISE EXCEPTION 'Payment requires reconciliation; outstanding balance or status changed'; END IF;
  SELECT owner_id INTO landlord FROM listings WHERE id=c.listing_id;
  method:=CASE WHEN a.provider='simulated' THEN 'Simulated TEST' ELSE 'shurjoPay TEST' END;
  confirmation:=CASE WHEN a.provider='simulated' THEN 'Simulated payment — no real money transferred. Internal development simulator; not an official gateway verification.'
    ELSE 'TEST payment independently verified with shurjoPay sandbox. No real money transferred. No landlord payout.' END;
  INSERT INTO payment_events(payment_id,amount,method,status,claimed_by,confirmed_at,request_key)
    VALUES(p.id,a.amount,method,'confirmed',a.tenant_id,now(),'sandbox:'||a.id) RETURNING id INTO ev;
  balance:=rental_outstanding(p.id);
  -- Legacy notification trigger is suppressed for TEST methods below.
  UPDATE payments SET payment_method=method,status=CASE WHEN balance=0 THEN 'confirmed'
    WHEN due_date<(now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'overdue' ELSE 'pending' END,
    paid_at=CASE WHEN balance=0 THEN now() AT TIME ZONE 'UTC' ELSE NULL END WHERE id=p.id;
  snap:=rental_contract_snapshot(c.id)||jsonb_build_object('payment_id',p.id,'event_id',ev,'amount_received',a.amount::text,
    'outstanding_balance',balance::text,'category',p.category,'billing_month',p.billing_month,'payment_method',method,
    'confirmed_at',now(),'issuer_name','Nibash sandbox verification','test_payment',true,'provider_order_id',a.provider_order_id,
    'confirmation',confirmation,'provider',a.provider);
  INSERT INTO rental_documents(contract_id,kind,version_key,event_id,owner_id,tenant_id,snapshot)
    VALUES(c.id,'acknowledgment','payment-event:'||ev,ev,landlord,c.tenant_id,snap) RETURNING id INTO doc;
  UPDATE payment_attempts SET state='succeeded',event_id=ev,verification=v,last_error=NULL,lease_until=NULL,lease_token=NULL WHERE id=a.id;
  INSERT INTO rental_audit_events(contract_id,kind,details) VALUES(c.id,'sandbox_payment_verified',jsonb_build_object('attempt_id',a.id,'event_id',ev,'document_id',doc));
  INSERT INTO notifications(user_id,contract_id,payment_id,kind,title,body,event_key)
    SELECT recipient,c.id,p.id,'payment_installment',CASE WHEN a.provider='simulated' THEN 'Simulated payment — TEST' ELSE 'TEST sandbox payment verified' END,
      format('%s TEST BDT %s. Remaining BDT %s. Acknowledgment is being prepared.',confirmation,a.amount,balance),'sandbox:'||a.id
    FROM (SELECT c.tenant_id AS recipient UNION SELECT landlord) recipients ON CONFLICT(user_id,event_key) DO NOTHING;
  RETURN doc;
END; $$;

-- Preserve the original notification implementation for every existing payment method.
DROP TRIGGER payment_inbox_event ON payments;
CREATE TRIGGER payment_inbox_event AFTER INSERT OR UPDATE ON payments
  FOR EACH ROW WHEN (NEW.payment_method IS NULL OR NEW.payment_method NOT IN ('shurjoPay TEST','Simulated TEST')) EXECUTE FUNCTION notify_payment_event();

ALTER TABLE sandbox_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulated_provider_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sandbox_contracts,payment_attempts,simulated_provider_transactions FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_sandbox_payment(text,jsonb) FROM PUBLIC;
DO $$ DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON sandbox_contracts,payment_attempts,simulated_provider_transactions FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION confirm_sandbox_payment(text,jsonb) FROM %I',role_name);
    END IF;
  END LOOP;
END; $$;
COMMIT;
