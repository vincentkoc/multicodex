ALTER TABLE participants ADD COLUMN access_token TEXT;

CREATE UNIQUE INDEX idx_participants_access_token ON participants(access_token);
