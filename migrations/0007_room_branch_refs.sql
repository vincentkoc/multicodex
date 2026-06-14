CREATE TABLE room_branch_refs (
  room_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  initial_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, branch),
  UNIQUE (branch),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
