ALTER TABLE room_creation_reservations ADD COLUMN lease_id TEXT;

CREATE UNIQUE INDEX idx_room_creation_reservations_lease
  ON room_creation_reservations(lease_id)
  WHERE lease_id IS NOT NULL;
