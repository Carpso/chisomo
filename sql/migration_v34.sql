-- Trust & segments (v0.5.2+):
-- 1) Campaign type: ngo | faith | emergency | medical | community | sponsor
--    drives segment-specific UI/copy on the campaign.
-- 2) Host KYC fields: capture an identity/registration document at application
--    time so admins can vet creators (NRC, NGO cert, or community endorsement).
ALTER TABLE campaigns ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'community';

ALTER TABLE users ADD COLUMN host_kyc_status TEXT NOT NULL DEFAULT 'none'; -- none | submitted | approved | rejected
ALTER TABLE users ADD COLUMN host_kyc_type TEXT;                            -- nrc | ngo_cert | endorsement
ALTER TABLE users ADD COLUMN host_kyc_doc_url TEXT;
ALTER TABLE users ADD COLUMN host_kyc_notes TEXT;
