-- v10: FCM token column for push notifications
ALTER TABLE users ADD COLUMN fcm_token TEXT;
CREATE INDEX IF NOT EXISTS idx_users_fcm_token ON users(fcm_token);