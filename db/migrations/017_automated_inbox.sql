BEGIN;

-- The existing overdue-payment procedure and API already use this status.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'overdue', 'confirmed', 'failed'));

CREATE TABLE notifications (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id integer NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  payment_id integer REFERENCES payments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('payment_created', 'payment_confirmed',
    'payment_rejected', 'contract_proposed', 'contract_signed',
    'contract_completed', 'contract_expiring')),
  title text NOT NULL,
  body text NOT NULL,
  event_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, event_key)
);

CREATE INDEX notifications_user_history ON notifications (user_id, id DESC);
CREATE INDEX notifications_user_unread ON notifications (user_id, id DESC) WHERE read_at IS NULL;

-- Nibash uses its own JWT-authenticated API with an owner database connection.
-- Supabase browser roles must not bypass recipient checks via the public schema.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE notifications FROM PUBLIC;
REVOKE ALL ON SEQUENCE notifications_id_seq FROM PUBLIC;

-- Payment creation may come from the API OR the monthly database procedure.
-- The trigger participates in that transaction, including any rollback.
CREATE FUNCTION notify_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recipient integer;
  apartment text;
  event_kind text;
  event_title text;
  event_body text;
  dedupe_key text;
BEGIN
  SELECT c.tenant_id, l.title INTO recipient, apartment
    FROM contracts c JOIN listings l ON l.id=c.listing_id WHERE c.id=NEW.contract_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'overdue') THEN RETURN NEW; END IF;
    event_kind := 'payment_created';
    event_title := 'Your rent payment is ready';
    event_body := format('A payment of BDT %s for %s%s%s is ready. Open your contract to review and pay.',
      NEW.amount, apartment,
      CASE WHEN NEW.billing_month IS NOT NULL THEN ' for ' || to_char(NEW.billing_month, 'FMMonth YYYY') ELSE '' END,
      CASE WHEN NEW.due_date IS NOT NULL THEN ', due ' || to_char(NEW.due_date, 'FMDD Mon YYYY') ELSE '' END);
    dedupe_key := 'payment-created:' || NEW.id;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status='confirmed' THEN
    event_kind := 'payment_confirmed';
    event_title := 'Your payment was confirmed';
    event_body := format('Your payment of BDT %s for %s has been confirmed by the owner.', NEW.amount, apartment);
  ELSIF (NEW.status IS DISTINCT FROM OLD.status AND NEW.status='failed')
      OR (OLD.payment_method='Cash' AND NEW.payment_method IS NULL AND NEW.status IN ('pending','overdue')) THEN
    event_kind := 'payment_rejected';
    event_title := 'Your payment needs attention';
    event_body := format('The owner rejected your payment of BDT %s for %s. Open your contract to review the payment and arrange payment with the owner.', NEW.amount, apartment);
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO notifications (user_id,contract_id,payment_id,kind,title,body,event_key)
    VALUES (recipient,NEW.contract_id,NEW.id,event_kind,event_title,event_body,dedupe_key)
    ON CONFLICT (user_id,event_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_inbox_event AFTER INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION notify_payment_event();

CREATE FUNCTION notify_contract_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner integer;
  apartment text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  END IF;
  SELECT owner_id,title INTO owner,apartment FROM listings WHERE id=NEW.listing_id;

  IF NEW.status='proposed' THEN
    INSERT INTO notifications (user_id,contract_id,kind,title,body,event_key)
      VALUES (NEW.tenant_id,NEW.id,'contract_proposed','A contract is ready for your signature',
        format('The owner has proposed a contract for %s. Review the terms and sign when you are ready.',apartment),
        'contract-proposed:' || NEW.id) ON CONFLICT (user_id,event_key) DO NOTHING;
  ELSIF NEW.status='signed' THEN
    INSERT INTO notifications (user_id,contract_id,kind,title,body,event_key)
      VALUES (owner,NEW.id,'contract_signed','Your tenant signed the contract',
        format('The tenant has signed the contract for %s.',apartment),
        'contract-signed:' || NEW.id) ON CONFLICT (user_id,event_key) DO NOTHING;
  ELSIF NEW.status='completed' THEN
    INSERT INTO notifications (user_id,contract_id,kind,title,body,event_key)
      SELECT recipient,NEW.id,'contract_completed','Your contract has ended',
        format('The contract for %s ended on %s. Open it to review the agreement and payment history.',
          apartment,to_char(NEW.end_date,'FMDD Mon YYYY')),
        'contract-completed:' || NEW.id
      FROM (SELECT NEW.tenant_id AS recipient UNION SELECT owner) recipients
      ON CONFLICT (user_id,event_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contract_inbox_event AFTER INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION notify_contract_event();

-- The date parameter permits deterministic month-end/leap-year tests.
-- PostgreSQL subtracts a calendar month and clamps to its final day.
CREATE FUNCTION generate_inbox_reminders(
  as_of date DEFAULT (now() AT TIME ZONE 'Asia/Dhaka')::date
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notifications (user_id,contract_id,payment_id,kind,title,body,event_key)
    SELECT c.tenant_id,c.id,p.id,'payment_created','Your rent payment is ready',
      format('A payment of BDT %s for %s%s%s is outstanding.%s',
        p.amount,l.title,
        CASE WHEN p.billing_month IS NOT NULL THEN ' for ' || to_char(p.billing_month,'FMMonth YYYY') ELSE '' END,
        CASE WHEN p.due_date IS NOT NULL THEN ', due ' || to_char(p.due_date,'FMDD Mon YYYY') ELSE '' END,
        CASE WHEN p.payment_method='Cash' THEN ' Your cash payment claim is awaiting owner confirmation.'
          ELSE ' Open your contract to review and pay.' END),
      'payment-created:' || p.id
    FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN listings l ON l.id=c.listing_id
    WHERE p.status IN ('pending','overdue')
    ON CONFLICT (user_id,event_key) DO NOTHING;

  INSERT INTO notifications (user_id,contract_id,kind,title,body,event_key)
    SELECT recipient.user_id,c.id,'contract_expiring','Your contract is ending soon',
      format('The contract for %s ends on %s. Please discuss renewal or move-out arrangements with the other party.',
        l.title,to_char(c.end_date,'FMDD Mon YYYY')),
      'contract-expiring:' || c.id || ':' || c.end_date
    FROM contracts c JOIN listings l ON l.id=c.listing_id
    CROSS JOIN LATERAL (SELECT c.tenant_id AS user_id UNION SELECT l.owner_id) recipient
    WHERE c.status='signed' AND as_of BETWEEN (c.end_date - interval '1 month')::date AND c.end_date
    ON CONFLICT (user_id,event_key) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION notify_payment_event(), notify_contract_event(), generate_inbox_reminders(date) FROM PUBLIC;
DO $access$
DECLARE browser_role text;
BEGIN
  FOR browser_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.notifications FROM %I',browser_role);
    EXECUTE format('REVOKE ALL ON SEQUENCE public.notifications_id_seq FROM %I',browser_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.notify_payment_event(), public.notify_contract_event(), public.generate_inbox_reminders(date) FROM %I',browser_role);
  END LOOP;
END;
$access$;

-- Only actionable current items are imported; old transitions are not replayed.
SELECT generate_inbox_reminders();

COMMIT;
