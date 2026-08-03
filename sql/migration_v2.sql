-- Migration v2: giver usernames + hide-amount privacy + leaderboard helpers
ALTER TABLE users ADD COLUMN username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
ALTER TABLE contributions ADD COLUMN hide_amount INTEGER NOT NULL DEFAULT 0;
