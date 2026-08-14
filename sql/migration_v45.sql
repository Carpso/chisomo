-- v45: Sponsor Desk — curated grant/empowerment opportunities pushed weekly to
-- active campaign hosts so the platform is their funding-intelligence source,
-- not just a payment processor.
CREATE TABLE IF NOT EXISTS sponsor_desk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Grant',
  amount_label TEXT NOT NULL DEFAULT '',   -- e.g. "Up to K50,000" or "In-kind"
  deadline TEXT,                           -- YYYY-MM-DD (nullable = rolling)
  link TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'hosts',  -- hosts | events | all
  status TEXT NOT NULL DEFAULT 'active',   -- active | archived
  published INTEGER NOT NULL DEFAULT 0,    -- 0 = draft, 1 = pushed + visible
  published_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sponsor_desk_status ON sponsor_desk(status, published, created_at);
