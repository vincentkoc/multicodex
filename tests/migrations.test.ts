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
