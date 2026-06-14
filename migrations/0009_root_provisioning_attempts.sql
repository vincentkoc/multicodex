ALTER TABLE rooms ADD COLUMN root_provisioning_attempted_at INTEGER;

UPDATE rooms
SET root_provisioning_attempted_at = updated_at
WHERE crabfleet_root_session_id IS NOT NULL
   OR EXISTS (
     SELECT 1
     FROM participants
     WHERE participants.room_id = rooms.id
       AND participants.crabfleet_session_id IS NOT NULL
   );
