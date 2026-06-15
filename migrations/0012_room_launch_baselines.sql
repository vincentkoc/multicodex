CREATE TABLE room_launch_baselines (
  room_id TEXT PRIMARY KEY,
  base_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
