CREATE TABLE room_runtime_refresh_leases (
  room_id TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_room_runtime_refresh_leases_next_allowed
  ON room_runtime_refresh_leases(next_allowed_at);
