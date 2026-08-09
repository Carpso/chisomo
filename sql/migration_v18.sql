-- Migration v18: self-hosted short-link cache.
-- Keeps public share links short/masked even before we own a custom domain.
-- Each unique long URL is shortened once; repeated requests reuse the cache.
CREATE TABLE IF NOT EXISTS short_links (
  long_url   TEXT PRIMARY KEY,
  short_url  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
