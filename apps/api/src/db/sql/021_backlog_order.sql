-- Backlog games can be marked as priority and put in the owner's own order.
ALTER TABLE list_entries ADD COLUMN IF NOT EXISTS priority boolean NOT NULL DEFAULT false;
ALTER TABLE list_entries ADD COLUMN IF NOT EXISTS position integer;
