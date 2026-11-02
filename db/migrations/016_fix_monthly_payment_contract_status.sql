-- Upgrade existing installations without replaying earlier migrations.
-- Duplicate contract/month rows must be reviewed before applying this migration;
-- creating the index fails safely rather than deleting payment records.
BEGIN;

ALTER TABLE Payments
  ADD COLUMN IF NOT EXISTS billing_month date,
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_contract_month
  ON Payments (contract_id, billing_month);

CREATE OR REPLACE PROCEDURE generate_monthly_payments()
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO Payments (contract_id, amount, status, billing_month, due_date)
  SELECT
    c.id,
    t.rent
      + COALESCE(t.electricity_bill, 0)
      + COALESCE(t.water_bill, 0)
      + COALESCE(t.service_charge, 0),
    'pending',
    date_trunc('month', CURRENT_DATE)::date,
    (date_trunc('month', CURRENT_DATE)
       + (LEAST(t.monthly_due_date, 28) - 1) * interval '1 day')::date
  FROM Contracts c
  JOIN Agreements a ON a.terms_id = c.agreement_id
  JOIN Terms t      ON t.id = a.terms_id
  WHERE c.status = 'signed'
    AND CURRENT_DATE BETWEEN c.start_date AND c.end_date
  ON CONFLICT (contract_id, billing_month) DO NOTHING;
END;
$$;

COMMIT;
