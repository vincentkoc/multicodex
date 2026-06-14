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
