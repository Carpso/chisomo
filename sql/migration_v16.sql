-- Migration v16: admin settings for SMS status text and intruder alerts
CREATE TABLE IF NOT EXISTS admin_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Track failed OTP/login attempts for intruder detection.
CREATE TABLE IF NOT EXISTS failed_logins (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  phone     TEXT NOT NULL,
  ip        TEXT,
  user_agent TEXT,
  reason    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_failed_logins_phone ON failed_logins(phone);
CREATE INDEX IF NOT EXISTS idx_failed_logins_created ON failed_logins(created_at);