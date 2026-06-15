ALTER TABLE participants ADD COLUMN upgrade_claim_id TEXT;

CREATE UNIQUE INDEX idx_participants_upgrade_claim
  ON participants(upgrade_claim_id)
  WHERE upgrade_claim_id IS NOT NULL;
