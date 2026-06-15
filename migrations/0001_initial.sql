CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  host_participant_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  crabfleet_root_session_id TEXT,
  brief_json TEXT NOT NULL DEFAULT '{}',
  brief_revision INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL,
  started_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  github_login TEXT,
  role_id TEXT,
  task_id TEXT,
  crabfleet_session_id TEXT,
  browser_url TEXT,
  runtime_summary TEXT NOT NULL DEFAULT '',
  branch TEXT,
  state TEXT NOT NULL,
  joined_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_participants_room ON participants(room_id, created_at);

CREATE TABLE room_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  body TEXT NOT NULL,
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_room_messages_room ON room_messages(room_id, created_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_participant_id TEXT,
  state TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  owns_paths_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  pull_request_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_tasks_room ON tasks(room_id, created_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_id TEXT NOT NULL,
  affected_task_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_decisions_room ON decisions(room_id, created_at);

CREATE TABLE conductor_actions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_ids_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  approval_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_conductor_actions_room ON conductor_actions(room_id, created_at);
