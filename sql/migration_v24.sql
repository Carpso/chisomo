-- v24: Lipila audit log.
-- Records every outbound Lipila collection/disbursement attempt and its
-- result, so admin can reconcile payments/sms without digging worker logs.
CREATE TABLE IF NOT EXISTS lipila_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,            -- collection | disbursement
  reference_id  TEXT NOT NULL,
  phone         TEXT,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL,            -- pending | success | failed | error
  lipila_status TEXT,                     -- raw Lipila status field
  message       TEXT,                     -- Lipila message / error text
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_lipila_logs_ref   ON lipila_logs(reference_id);
CREATE INDEX IF NOT EXISTS idx_lipila_logs_kind  ON lipila_logs(kind, created_at);
