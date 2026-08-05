-- Migration v15: persist Africa's Talking SMS callback payloads
-- (delivery reports, inbound messages, opt-outs, subscription notifications)
-- per AT's recommendation to keep a copy of everything they POST.
CREATE TABLE IF NOT EXISTS sms_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'other',
  ref_id TEXT,
  status TEXT,
  phone TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_events_ref ON sms_events(ref_id);
CREATE INDEX IF NOT EXISTS idx_sms_events_phone ON sms_events(phone);
CREATE INDEX IF NOT EXISTS idx_sms_events_received ON sms_events(received_at);
