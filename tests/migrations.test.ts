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
