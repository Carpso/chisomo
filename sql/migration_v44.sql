-- v44: Admin-configurable event finder's commission (default K10) + editable
-- platform fees, set from the admin dashboard without redeploying.
ALTER TABLE campaigns ADD COLUMN waive_event_fees INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('event_commission_enabled', 'false');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('event_commission_finder_fee_cents', '1000');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('event_commission_card_finder_fee_cents', '1000');
-- Editable platform fee overrides (fall back to wrangler vars when unset).
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('platform_fee_pct', '1');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('platform_min_fee_cents', '300');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('platform_fixed_fee_cents', '48');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('card_platform_fee_pct', '2');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('card_platform_min_fee_cents', '500');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('card_lipila_collection_fee_pct', '2.5');
