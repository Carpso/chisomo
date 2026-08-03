-- v7: optional campaign deadline (ends_at) for countdown urgency
ALTER TABLE campaigns ADD COLUMN ends_at TEXT;
