-- Migration v3: host approvals + superadmin
ALTER TABLE users ADD COLUMN host_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN host_org TEXT;
ALTER TABLE users ADD COLUMN host_role TEXT;
ALTER TABLE users ADD COLUMN host_reason TEXT;
ALTER TABLE users ADD COLUMN host_rejection TEXT;
