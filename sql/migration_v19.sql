-- Migration v19: intruder alert scan — track which failed logins have been reported
ALTER TABLE failed_logins ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
