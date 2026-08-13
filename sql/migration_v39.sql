-- v0.5.8+:
-- Internal Kingdom Sponsor team group chat (staff discussion + file sharing).
CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  username TEXT NOT NULL DEFAULT 'Team',
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_messages ON team_messages(id DESC);
