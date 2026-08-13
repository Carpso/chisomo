-- v43: Store card donor emails on contributions so the admin can see and
-- contact everyone who gave by card (previously emails went straight to Lipila).
ALTER TABLE contributions ADD COLUMN email TEXT;
CREATE INDEX IF NOT EXISTS idx_contrib_email ON contributions(email);
