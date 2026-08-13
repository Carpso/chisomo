-- v0.5.5+:
-- 1) campaign_views: a user who opens a private invite link can find it again
--    under "Recently opened" on the home screen instead of needing the link.
-- 2) campaigns.waive_payout_fees: per-campaign toggle that waives the platform
--    payout cut + Lipila disbursement fee (hosts/events cover or waive them).
-- 3) campaigns.event_tiers: JSON array of ticket tiers for event campaigns
--    (e.g. [{"name":"Standard","amountCents":20000}]).
-- 4) users.org_type: host application category (individual | ngo | agency).
-- 5) users.last_login_at: captured on every successful login/signup so the
--    admin dashboard can list recent activity.
CREATE TABLE IF NOT EXISTS campaign_views (
  user_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_views_user ON campaign_views(user_id, viewed_at);

ALTER TABLE campaigns ADD COLUMN waive_payout_fees INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN event_tiers TEXT;

ALTER TABLE users ADD COLUMN org_type TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
