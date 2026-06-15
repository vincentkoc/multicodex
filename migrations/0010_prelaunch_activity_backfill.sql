UPDATE rooms
SET updated_at = MAX(
  updated_at,
  COALESCE((SELECT MAX(created_at) FROM room_messages WHERE room_id = rooms.id), updated_at),
  COALESCE((SELECT MAX(updated_at) FROM participants WHERE room_id = rooms.id), updated_at),
  COALESCE((SELECT MAX(updated_at) FROM tasks WHERE room_id = rooms.id), updated_at),
  COALESCE((SELECT MAX(created_at) FROM decisions WHERE room_id = rooms.id), updated_at),
  COALESCE((SELECT MAX(created_at) FROM conductor_actions WHERE room_id = rooms.id), updated_at)
)
WHERE status IN ('setup', 'planning');
