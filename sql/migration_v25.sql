-- v25: Referral reward system.
-- Users who reach the referral threshold (admin_settings.referral_reward_threshold,
-- default 5) become eligible to be rewarded by an admin (manual reward action).

-- Track when a referrer was rewarded by an admin.
ALTER TABLE users ADD COLUMN referral_rewarded_at TEXT;

-- Remove duplicate referral links (keep the earliest) so one user can only be
-- linked to one referrer. Needed before the unique index below can be created.
DELETE FROM referrals WHERE id NOT IN (
  SELECT MIN(id) FROM referrals GROUP BY referred_user_id
);

-- One referred user can only be linked to one referrer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refs_referred ON referrals(referred_user_id);

-- Configurable referral reward threshold (number of signups that qualify a user
-- for an admin reward). Admin can change it via the admin settings screen.
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('referral_reward_threshold', '5');
