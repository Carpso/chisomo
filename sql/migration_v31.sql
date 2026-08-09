-- Host verification (v0.4.9+): admins can mark a host as independently
-- verified (beyond the in-app application) and store private verification
-- notes (e.g. "checked ZRA business registration, called the office").
ALTER TABLE users ADD COLUMN host_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN host_verification_notes TEXT;
