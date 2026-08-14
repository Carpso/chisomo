-- v47: Campaign / event chat — a private, campaign-scoped conversation between
-- the host and confirmed donors / ticket holders (and RSVPs). Reuses the
-- existing notification/push pipeline: a new message pushes to everyone who has
-- contributed to that campaign.
CREATE TABLE IF NOT EXISTS campaign_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_chat_campaign ON campaign_chat(campaign_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_campaign_chat_user ON campaign_chat(user_id);
