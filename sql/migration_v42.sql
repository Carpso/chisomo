-- v42: Host → donor updates with superadmin/assistant moderation.
-- announcements gain a moderation workflow: hosts submit, admins approve/reject.
ALTER TABLE announcements ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE announcements ADD COLUMN reviewer_user_id INTEGER REFERENCES users(id);
ALTER TABLE announcements ADD COLUMN reviewed_at TEXT;
ALTER TABLE announcements ADD COLUMN rejection_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_announce_status ON announcements(status, campaign_id);
