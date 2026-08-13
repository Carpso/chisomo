-- v0.5.7+:
-- 1) notifications: in-app history of pushes (donations, tickets, milestones…)
--    so nothing is lost when a push is missed/blocked.
-- 2) campaigns event depth: capacity (0 = unlimited), date + venue.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  data TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);

ALTER TABLE campaigns ADD COLUMN event_capacity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN event_date TEXT;
ALTER TABLE campaigns ADD COLUMN event_venue TEXT;
