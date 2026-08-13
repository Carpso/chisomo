-- Migration v41: real event tickets (tier + quantity on contributions) and RSVP.
ALTER TABLE contributions ADD COLUMN tier_name TEXT;
ALTER TABLE contributions ADD COLUMN ticket_qty INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS event_rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  user_id INTEGER,
  name TEXT,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_rsvps_event_phone ON event_rsvps(event_id, phone);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_id);