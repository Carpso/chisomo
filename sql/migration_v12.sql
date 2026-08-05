-- 12. Donor profile photos: users.avatar_url (R2 media key stored as URL)

ALTER TABLE users ADD COLUMN avatar_url TEXT;
