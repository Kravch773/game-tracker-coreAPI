ALTER TABLE origin_studios ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'developer';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'origin_studios'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) NOT LIKE '%role%'
  ) THEN
    ALTER TABLE origin_studios DROP CONSTRAINT origin_studios_pkey;
    ALTER TABLE origin_studios ADD PRIMARY KEY (list, role, name);
  END IF;
END $$;
