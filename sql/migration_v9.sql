-- v9: recurring pledges, promoted campaigns (top-5 paid slots) + promotions audit
ALTER TABLE campaigns ADD COLUMN promoted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN promoted_until TEXT;

-- Donor "give every month" reminders. Reminder day = day_of_month (1-28) they set up.
CREATE TABLE IF NOT EXISTS recurring_pledges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaigns(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  phone            TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  day_of_month     INTEGER NOT NULL DEFAULT 1,
  active           INTEGER NOT NULL DEFAULT 1,
  last_reminded_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pledges_day ON recurring_pledges(day_of_month, active);

-- Paid promotion purchases (max 5 active slots, enforced in app).
CREATE TABLE IF NOT EXISTS promotions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id      INTEGER NOT NULL REFERENCES campaigns(id),
  amount_cents     INTEGER NOT NULL,
  days             INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | active | expired | refunded
  lipila_reference TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
