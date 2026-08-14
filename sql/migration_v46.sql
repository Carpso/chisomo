-- v46: Event reminders (48h / 2h countdown pushes to ticket holders + host).
-- events carry a start TIME (HH:MM, CAT) alongside event_date; reminders track
-- which buckets were already fired so the cron never double-sends.

ALTER TABLE campaigns ADD COLUMN event_time TEXT;          -- "14:30" local CAT
ALTER TABLE campaigns ADD COLUMN event_remind_48h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN event_remind_2h INTEGER NOT NULL DEFAULT 0;

-- Sponsor Desk: track how many hosts have applied per opportunity + whether the
-- publishing admin tagged matching categories (comma-separated campaign cats).
ALTER TABLE sponsor_desk ADD COLUMN match_categories TEXT;
ALTER TABLE sponsor_desk ADD COLUMN applied_count INTEGER NOT NULL DEFAULT 0;

-- Recurring giving: auto-charge a pledge when it's due (in addition to the
-- reminder), via a Lipila mobile-money prompt.
ALTER TABLE recurring_pledges ADD COLUMN last_charged_at TEXT;
ALTER TABLE recurring_pledges ADD COLUMN last_lipila_reference TEXT;
