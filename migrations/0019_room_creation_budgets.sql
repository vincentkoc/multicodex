CREATE TABLE room_creation_budgets (
  source_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  creation_count INTEGER NOT NULL
);

CREATE INDEX idx_room_creation_budgets_window
  ON room_creation_budgets(window_started_at);
