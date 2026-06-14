ALTER TABLE rooms ADD COLUMN builder_invite_token TEXT;

CREATE UNIQUE INDEX idx_rooms_builder_invite_token
  ON rooms(builder_invite_token)
  WHERE builder_invite_token IS NOT NULL;
