-- v26: Airtime payments + fulfillment.
-- Airtime orders now go through the Lipila mobile-money collection flow
-- (order -> pay via phone prompt -> fulfilled via Africa's Talking airtime API).

ALTER TABLE airtime_orders ADD COLUMN lipila_reference TEXT;
ALTER TABLE airtime_orders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE airtime_orders ADD COLUMN error TEXT;
ALTER TABLE airtime_orders ADD COLUMN credits_used_cents INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_airtime_ref ON airtime_orders(lipila_reference);
