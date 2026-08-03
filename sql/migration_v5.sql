-- Migration v5: track Kingdom Sponsor's payout cut (platform_fee_cents) on
-- withdrawals so the platform earns max(K3, 1%) on disbursements too.
ALTER TABLE withdrawals ADD COLUMN platform_fee_cents INTEGER NOT NULL DEFAULT 0;
