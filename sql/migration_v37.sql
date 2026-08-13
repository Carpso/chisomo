-- v0.5.4+ backfill: the Lipila logs screen showed everything as "pending"
-- because logs were never flipped to their final status on webhook confirmation.
-- The code now updates logs on confirm/fail; this backfills the rows that
-- actually succeeded so the admin view is truthful immediately.
UPDATE lipila_logs SET status = 'success', lipila_status = 'success', updated_at = datetime('now')
WHERE kind = 'collection' AND status IN ('pending', 'unknown', 'error')
  AND EXISTS (
    SELECT 1 FROM contributions c
    WHERE c.status = 'confirmed' AND lipila_logs.reference_id LIKE c.lipila_reference || '%'
  );

UPDATE lipila_logs SET status = 'success', lipila_status = 'success', updated_at = datetime('now')
WHERE kind = 'disbursement' AND status IN ('pending', 'unknown', 'error')
  AND EXISTS (
    SELECT 1 FROM withdrawals w
    WHERE w.status = 'success' AND lipila_logs.reference_id LIKE w.lipila_reference || '%'
  );
