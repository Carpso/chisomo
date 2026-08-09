-- Migration v23: payout failure observability.
-- Records why a withdrawal (host payout) failed so admin can diagnose
-- without digging through worker logs. Backfills are not needed: existing
-- failed rows simply stay NULL until the next attempt.
ALTER TABLE withdrawals ADD COLUMN error TEXT;
