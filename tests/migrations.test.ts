import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("runtime leases are durable and expire", async () => {
	const migration = await readFile(
		new URL("../migrations/0003_room_runtime_leases.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /room_id TEXT PRIMARY KEY/);
	assert.match(migration, /lease_id TEXT NOT NULL UNIQUE/);
	assert.match(migration, /expires_at INTEGER NOT NULL/);
});

test("retired runtime identifiers remain available for redaction", async () => {
	const migration = await readFile(
		new URL("../migrations/0004_runtime_redactions.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /PRIMARY KEY \(room_id, identifier\)/);
	assert.match(migration, /identifier TEXT NOT NULL/);
});

test("join request capabilities can be recovered idempotently", async () => {
	const migration = await readFile(
		new URL("../migrations/0005_participant_join_requests.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /join_request_id TEXT/);
	assert.match(migration, /UNIQUE INDEX idx_participants_room_join_request/);
});

test("room creation capabilities can be recovered idempotently", async () => {
	const migration = await readFile(
		new URL("../migrations/0006_room_creation_requests.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /creation_request_id TEXT/);
	assert.match(migration, /UNIQUE INDEX idx_rooms_creation_request_id/);
});

test("room-owned GitHub refs are recorded durably", async () => {
	const migration = await readFile(
		new URL("../migrations/0007_room_branch_refs.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE room_branch_refs/);
	assert.match(migration, /PRIMARY KEY \(room_id, branch\)/);
	assert.match(migration, /UNIQUE \(branch\)/);
});

test("room builder invitations are durable capabilities", async () => {
	const migration = await readFile(
		new URL("../migrations/0008_room_builder_invites.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /builder_invite_token TEXT/);
	assert.match(migration, /UNIQUE INDEX idx_rooms_builder_invite_token/);
});

test("root provisioning attempts are durable cleanup evidence", async () => {
	const migration = await readFile(
		new URL("../migrations/0009_root_provisioning_attempts.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /root_provisioning_attempted_at INTEGER/);
	assert.match(migration, /crabfleet_root_session_id IS NOT NULL/);
	assert.match(migration, /participants\.crabfleet_session_id IS NOT NULL/);
});

test("pre-launch activity is backfilled before inactivity expiry", async () => {
	const migration = await readFile(
		new URL("../migrations/0010_prelaunch_activity_backfill.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /MAX\(created_at\) FROM room_messages/);
	assert.match(migration, /MAX\(updated_at\) FROM participants/);
	assert.match(migration, /MAX\(updated_at\) FROM tasks/);
	assert.match(migration, /status IN \('setup', 'planning'\)/);
});

test("participant chat budgets are durable per room seat", async () => {
	const migration = await readFile(
		new URL("../migrations/0013_room_message_budgets.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE room_message_budgets/);
	assert.match(migration, /PRIMARY KEY \(room_id, participant_id\)/);
	assert.match(migration, /window_started_at INTEGER NOT NULL/);
	assert.match(migration, /message_count INTEGER NOT NULL/);
});

test("root provisioning requests preserve exact replay inputs", async () => {
	const migration = await readFile(
		new URL("../migrations/0014_root_provisioning_requests.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /root_provisioning_request_json TEXT/);
});

test("room creation reservations have per-attempt leases", async () => {
	const migration = await readFile(
		new URL("../migrations/0015_room_creation_reservation_leases.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /lease_id TEXT/);
	assert.match(migration, /UNIQUE INDEX idx_room_creation_reservations_lease/);
});

test("observer upgrades have transaction-scoped claims", async () => {
	const migration = await readFile(
		new URL("../migrations/0016_participant_upgrade_claims.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /upgrade_claim_id TEXT/);
	assert.match(migration, /UNIQUE INDEX idx_participants_upgrade_claim/);
});

test("runtime refreshes have a durable room cooldown", async () => {
	const migration = await readFile(
		new URL("../migrations/0017_room_runtime_refresh_leases.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE room_runtime_refresh_leases/);
	assert.match(migration, /room_id TEXT PRIMARY KEY/);
	assert.match(migration, /next_allowed_at INTEGER NOT NULL/);
});

test("participant join replays preserve immutable admission inputs", async () => {
	const migration = await readFile(
		new URL("../migrations/0018_participant_join_replays.sql", import.meta.url),
		"utf8",
	);

	assert.match(migration, /CREATE TABLE participant_join_replays/);
	assert.match(migration, /PRIMARY KEY \(room_id, request_id\)/);
	assert.match(migration, /INSERT OR IGNORE INTO participant_join_replays/);
	assert.match(migration, /WHERE join_request_id IS NOT NULL/);
});
