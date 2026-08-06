-- Migration v22: Host badge system + airtime system
CREATE TABLE IF NOT EXISTS host_badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tier TEXT NOT NULL DEFAULT 'basic', -- basic | pro | annual
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' -- active | expired | cancelled
);
CREATE INDEX IF NOT EXISTS idx_host_badges_user ON host_badges(user_id);
CREATE INDEX IF NOT EXISTS idx_host_badges_expires ON host_badges(expires_at);

CREATE TABLE IF NOT EXISTS airtime_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  phone TEXT NOT NULL,
  network TEXT NOT NULL, -- airtel | mtn | zamtel
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_airtime_user ON airtime_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_airtime_status ON airtime_orders(status);

-- Airtime system settings (admin controlled)
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('airtime_enabled', 'false');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('airtime_markup_pct', '5');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('airtime_min_amount_cents', '500');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('airtime_max_amount_cents', '50000');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('host_badge_enabled', 'false');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('host_badge_base_price_cents', '5000');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('host_badge_pro_price_cents', '15000');
INSERT OR IGNORE INTO admin_settings (key, value) VALUES ('host_badge_annual_price_cents', '120000');
