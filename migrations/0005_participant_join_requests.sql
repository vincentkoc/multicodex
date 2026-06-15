ALTER TABLE participants ADD COLUMN join_request_id TEXT;

CREATE UNIQUE INDEX idx_participants_room_join_request
  ON participants(room_id, join_request_id)
  WHERE join_request_id IS NOT NULL;
