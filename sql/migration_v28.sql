-- Public/private campaigns (v0.4.6+): private campaigns are hidden from the
-- public list and carousel but remain reachable by direct link/share and to
-- the host + admins.
ALTER TABLE campaigns ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
CREATE INDEX idx_campaigns_visibility ON campaigns (visibility);
