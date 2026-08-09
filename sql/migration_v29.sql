-- Admin assistants (v0.4.7+): superadmins can grant limited admin access to
-- other users. `permissions` is a comma-separated list of scopes:
--   campaigns, donations, tickets, users, settings, finance, restore
-- A superadmin always has full access (not stored here).
CREATE TABLE IF NOT EXISTS admin_assistants (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  permissions TEXT NOT NULL DEFAULT 'tickets',
  added_by    INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log of sensitive admin actions (deletes, restores, bans, rewards,
-- settings changes) so a superadmin can see what staff did and reverse it.
CREATE TABLE IF NOT EXISTS admin_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  action       TEXT NOT NULL,             -- e.g. campaign_delete, campaign_restore, ban, reward
  target_type  TEXT,                      -- e.g. campaign, user
  target_id    TEXT,
  details      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at);
