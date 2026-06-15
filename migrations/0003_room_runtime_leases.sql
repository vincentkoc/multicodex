CREATE TABLE room_runtime_leases (
  room_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_room_runtime_leases_expiry ON room_runtime_leases(expires_at);
