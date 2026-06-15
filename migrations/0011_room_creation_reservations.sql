CREATE TABLE room_creation_reservations (
  request_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_room_creation_reservations_expiry
  ON room_creation_reservations(expires_at);
