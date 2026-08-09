-- Campaign categories (v0.4.5+): every campaign carries a category for browsing/filtering.
ALTER TABLE campaigns ADD COLUMN category TEXT DEFAULT 'Other';
CREATE INDEX idx_campaigns_category ON campaigns (category);
