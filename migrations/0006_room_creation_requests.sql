ALTER TABLE rooms ADD COLUMN creation_request_id TEXT;

CREATE UNIQUE INDEX idx_rooms_creation_request_id
  ON rooms(creation_request_id)
  WHERE creation_request_id IS NOT NULL;
