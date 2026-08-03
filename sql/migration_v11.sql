-- v11: Group Sponsor features
-- 1. Joint pledge: add partner_user_id to recurring_pledges
ALTER TABLE recurring_pledges ADD COLUMN partner_user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_pledges_partner ON recurring_pledges(partner_user_id);

-- 2. Gift sponsorship: giver_user_id on contributions (who paid) vs donor_user_id (who receives credit)
ALTER TABLE contributions ADD COLUMN giver_user_id INTEGER REFERENCES users(id);
ALTER TABLE contributions ADD COLUMN is_gift INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_contrib_giver ON contributions(giver_user_id);

-- 3. Group campaigns: min_sponsors target + current count
ALTER TABLE campaigns ADD COLUMN min_sponsors INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campaigns ADD COLUMN sponsor_count INTEGER NOT NULL DEFAULT 0;
-- New table to track campaign sponsors (for group unlock logic)
CREATE TABLE IF NOT EXISTS campaign_sponsors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id     INTEGER NOT NULL REFERENCES campaigns(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_sponsors_campaign ON campaign_sponsors(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sponsors_user ON campaign_sponsors(user_id);

-- 4. Couple/family accounts: user_links
CREATE TABLE IF NOT EXISTS user_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  linked_user_id INTEGER NOT NULL REFERENCES users(id),
  link_type   TEXT NOT NULL DEFAULT 'family', -- family | couple | team
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, linked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_links_user ON user_links(user_id);
CREATE INDEX IF NOT EXISTS idx_user_links_linked ON user_links(linked_user_id);