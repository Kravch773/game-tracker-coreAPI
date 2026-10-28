-- One-time codes sent by email: signup confirmation and password reset.
CREATE TABLE IF NOT EXISTS email_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL,
  email text NOT NULL,
  code_hash text NOT NULL,
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_codes_lookup_idx ON email_codes (purpose, email);
