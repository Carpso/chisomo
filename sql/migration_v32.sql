-- Host edit-request workflow (v0.5.0+): hosts cannot edit campaigns directly
-- (fraud protection). Instead they submit proposed changes which a superadmin
-- reviews and approves/rejects. `proposed_json` stores the editable fields.
CREATE TABLE IF NOT EXISTS campaign_edit_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id),
  host_user_id INTEGER NOT NULL,
  proposed_json TEXT NOT NULL,          -- {title?, description?, goalCents?, ...}
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  admin_notes  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_edit_requests_status ON campaign_edit_requests (status, created_at);
