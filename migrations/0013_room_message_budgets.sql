CREATE TABLE room_message_budgets (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id),
  FOREIGN KEY (participant_id) REFERENCES participants(id)
);

CREATE INDEX idx_room_message_budgets_window
  ON room_message_budgets(window_started_at);
