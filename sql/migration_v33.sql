-- Airtime delivery-status tracking (v0.5.1+): Africa's Talking returns a
-- `requestId` per recipient when airtime is sent; its status callback then
-- reports Success/Failed for that requestId. Store it so we can match the
-- instant delivery notification and update the order.
ALTER TABLE airtime_orders ADD COLUMN at_request_id TEXT;
ALTER TABLE airtime_orders ADD COLUMN sent_at TEXT;
ALTER TABLE airtime_orders ADD COLUMN delivered_at TEXT;
CREATE INDEX IF NOT EXISTS idx_airtime_at_request ON airtime_orders (at_request_id);
