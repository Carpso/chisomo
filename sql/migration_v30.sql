-- IP-based rate limiting for OTP requests + intruder detection (v0.4.8+).
-- Protects against SMS-bombing from a single source and strengthens the
-- failed-login intruder alerts with per-IP visibility.
CREATE TABLE IF NOT EXISTS otp_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  phone      TEXT,
  kind       TEXT NOT NULL DEFAULT 'otp',  -- otp | verify
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otp_attempts_ip ON otp_attempts (ip, created_at);
