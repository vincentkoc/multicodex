CREATE TABLE participant_join_replays (
  room_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  github_login TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, request_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (participant_id) REFERENCES participants(id)
);

INSERT OR IGNORE INTO participant_join_replays
  (room_id, request_id, participant_id, kind, display_name, github_login, created_at)
SELECT room_id, join_request_id, id, kind, display_name, github_login, created_at
FROM participants
WHERE join_request_id IS NOT NULL;

CREATE INDEX idx_participant_join_replays_participant
  ON participant_join_replays(participant_id);
