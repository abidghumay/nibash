ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_document_type_check,
  ADD CONSTRAINT documents_document_type_check CHECK (
    document_type IN (
      'dolil_deed',
      'electricity_bill_receipt',
      'holding_tax_receipt',
      'water_bill_receipt',
      'trade_license',
      'nid',
      'passport',
      'driving_license'
    )
  );

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ai_status VARCHAR(20) DEFAULT 'pending'
    CHECK (ai_status IN ('pending', 'auto_rejected', 'flagged', 'passed', 'failed')),
  ADD COLUMN IF NOT EXISTS ai_score INTEGER CHECK (ai_score >= 0 AND ai_score <= 100),
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_flags JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_extracted_data JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_evaluated_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_documents_ai_status ON documents(ai_status);
