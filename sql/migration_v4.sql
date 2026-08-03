-- Migration v4: track the Lipila disbursement fee at payout time so it is
-- actually deducted from the host's available balance (no double counting).
ALTER TABLE withdrawals ADD COLUMN disbursement_fee_cents INTEGER NOT NULL DEFAULT 0;
