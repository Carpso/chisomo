-- Kingdom Sponsor - fundraising platform schema (Cloudflare D1 / SQLite)

-- All money amounts are stored in ngwee (integer cents) to avoid float errors.
-- 1 ZMW = 100 ngwee.

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT UNIQUE NOT NULL,
  username        TEXT UNIQUE,
  name            TEXT,
  is_host         INTEGER NOT NULL DEFAULT 0,
  host_status     TEXT NOT NULL DEFAULT 'none', -- none | pending | approved | rejected
  host_org        TEXT,
  host_role       TEXT,
  host_reason     TEXT,
  host_rejection  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT UNIQUE NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  image_url         TEXT,
  goal_cents        INTEGER NOT NULL DEFAULT 0,
  min_withdraw_cents INTEGER NOT NULL DEFAULT 20000,
  host_user_id      INTEGER NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'active', -- active | ended
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at          TEXT
);

CREATE TABLE IF NOT EXISTS contributions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id        INTEGER NOT NULL REFERENCES campaigns(id),
  donor_user_id      INTEGER REFERENCES users(id),
  donor_name         TEXT,
  is_anonymous       INTEGER NOT NULL DEFAULT 0,
  hide_amount        INTEGER NOT NULL DEFAULT 0,
  phone              TEXT NOT NULL, -- private; never exposed publicly
  amount_cents       INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  lipila_fee_cents   INTEGER NOT NULL DEFAULT 0,
  lipila_reference   TEXT,
  lipila_identifier  TEXT,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
  confirmed_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contrib_campaign ON contributions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_contrib_status  ON contributions(status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id       INTEGER NOT NULL REFERENCES campaigns(id),
  amount_cents      INTEGER NOT NULL,
  disbursement_fee_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  lipila_reference  TEXT,
  lipila_identifier TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_withdraw_campaign ON withdrawals(campaign_id);

CREATE TABLE IF NOT EXISTS otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otps(phone);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
