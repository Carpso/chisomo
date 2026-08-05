-- Kingdom Sponsor migration v13 (Aug 2026)
-- Support tickets, campaign delete requests, receipt download tracking, scale indexes.

CREATE TABLE IF NOT EXISTS support_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  phone       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open', -- open | answered | closed
  admin_reply TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_user   ON support_tickets(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status, created_at);

CREATE TABLE IF NOT EXISTS campaign_delete_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delreq_status ON campaign_delete_requests(status);

CREATE TABLE IF NOT EXISTS receipt_downloads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contribution_id INTEGER NOT NULL REFERENCES contributions(id),
  downloaded_by   INTEGER REFERENCES users(id),
  phone           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rcptdl_contrib ON receipt_downloads(contribution_id);
CREATE INDEX IF NOT EXISTS idx_rcptdl_created ON receipt_downloads(created_at);

-- Scale: cover the hot query paths used per-campaign and in the admin ledger.
CREATE INDEX IF NOT EXISTS idx_contrib_donor   ON contributions(donor_user_id, status);
CREATE INDEX IF NOT EXISTS idx_contrib_created ON contributions(created_at);
CREATE INDEX IF NOT EXISTS idx_withdraw_status ON withdrawals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pledges_user    ON recurring_pledges(user_id);
CREATE INDEX IF NOT EXISTS idx_promos_campaign ON promotions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_promos_status   ON promotions(status, expires_at);
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_announce_camp   ON announcements(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_host   ON campaigns(host_user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, promoted, created_at);
