-- Referral rewards (v0.5.4+):
-- The reward threshold default moved from 5 to 10 invited sign-ups. This upserts
-- the admin setting so existing deployments adopt the new target too (admins can
-- still change it from the Referral rewards screen).
INSERT INTO admin_settings (key, value)
VALUES ('referral_reward_threshold', '10')
ON CONFLICT(key) DO UPDATE SET value = '10'
WHERE key = 'referral_reward_threshold' AND CAST(value AS INTEGER) < 10;
