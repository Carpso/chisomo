-- Migration v21: notifications toggle and airtime rewards credit column
ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN airtime_credits_cents INTEGER NOT NULL DEFAULT 0;
