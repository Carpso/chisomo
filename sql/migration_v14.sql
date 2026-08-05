-- Kingdom Sponsor migration v14 (Aug 2026)
-- Multi-device push, promo refunds, referral codes, ticket auto-close, scale indexes.

ALTER TABLE support_tickets ADD COLUMN closed_at TEXT;

CREATE TABLE IF NOT EXISTS device_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  token        TEXT UNIQUE NOT NULL,
  platform     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devtokens_user ON device_tokens(user_id);

ALTER TABLE users ADD COLUMN referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ref_code ON users(referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id  INTEGER NOT NULL REFERENCES users(id),
  referred_user_id  INTEGER NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_pair     ON referrals(referrer_user_id, referred_user_id);
CREATE INDEX IF NOT EXISTS idx_refs_referrer        ON referrals(referrer_user_id, created_at);

CREATE TABLE IF NOT EXISTS refunds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_id        INTEGER REFERENCES promotions(id),
  amount_cents    INTEGER NOT NULL,
  lipila_reference TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_promo ON refunds(promo_id);

-- Scale: hot per-campaign queries used by balances, milestones and ledgers.
CREATE INDEX IF NOT EXISTS idx_contrib_camp_status   ON contributions(campaign_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_withdraw_camp_status  ON withdrawals(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_contrib_phone         ON contributions(phone, status);
