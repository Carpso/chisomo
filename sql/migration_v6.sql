-- v6: ledger of Kingdom Sponsor's own fee settlements & sweeps
-- (separate from host payouts in withdrawals, so campaign FK stays clean)
CREATE TABLE IF NOT EXISTS fee_sweeps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL DEFAULT 'payout', -- payout | sweep
  amount_cents      INTEGER NOT NULL,
  lipila_reference  TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | success | failed
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fee_sweeps_status ON fee_sweeps(status);
