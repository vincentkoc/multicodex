CREATE TABLE room_runtime_redactions (
  room_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, identifier),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_room_runtime_redactions_room ON room_runtime_redactions(room_id, created_at);
