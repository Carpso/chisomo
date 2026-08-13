-- v0.6.1+:
-- Event attendee check-in: hosts scan attendees' QR codes at events and
-- record their presence. One row per attendee per event.
CREATE TABLE IF NOT EXISTS event_attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES campaigns(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_attendees_event ON event_attendees(event_id, id DESC);
