import assert from "node:assert/strict";
import test from "node:test";

import type { Room } from "../src/domain.ts";
import { ensureRoomBranches, resolveRepoDefaultBranch } from "../src/github.ts";

const room = {
	id: "room-1",
	repo: "example/repo",
	baseBranch: "main",
	integrationBranch: "multicodex/room/integration",
} as Room;

type BranchOwnership = { room_id: string; initial_sha: string };

function branchDb(initialOwnership: BranchOwnership | null = null): D1Database {
	let ownership = initialOwnership;
	return {
		prepare(sql: string) {
			let values: unknown[] = [];
			const statement = {
				bind(...next: unknown[]) {
					values = next;
					return statement;
				},
				async first() {
					return ownership;
				},
				async run() {
					if (sql.startsWith("INSERT OR IGNORE") && !ownership) {
						ownership = {
							room_id: String(values[0]),
							initial_sha: String(values[2]),
						};
					}
					return { success: true, meta: { changes: 1 } };
				},
			};
			return statement;
		},
	} as unknown as D1Database;
}

function githubEnv(db = branchDb()): Env {
	return { GITHUB_TOKEN: "token", DB: db } as Env;
}

test("room creation resolves the repository default branch", async () => {
	const originalFetch = globalThis.fetch;
	let authorization: string | null = null;
	globalThis.fetch = async (_input, init) => {
		authorization = new Headers(init?.headers).get("authorization");
		return Response.json({ default_branch: "master" });
	};
	try {
		assert.equal(await resolveRepoDefaultBranch({} as Env, "example/repo"), "master");
		assert.equal(authorization, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("room creation fails closed when GitHub omits the default branch", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({});
	try {
		await assert.rejects(resolveRepoDefaultBranch({} as Env, "example/repo"), /default branch/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("branch provisioning skips GitHub credentials only in explicit simulation", async () => {
	await assert.rejects(
		ensureRoomBranches({ MULTICODEX_SIMULATION_MODE: "false" } as Env, room, []),
		/GitHub token is not configured/,
	);
	await ensureRoomBranches({ MULTICODEX_SIMULATION_MODE: "true" } as unknown as Env, room, []);
});

test("branch provisioning safely reuses a room-owned ref after work advances it", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "advanced-room-sha" } }),
	];
	globalThis.fetch = async () => responses.shift()!;
	try {
		await ensureRoomBranches(
			githubEnv(branchDb({ room_id: room.id, initial_sha: "base-sha" })),
			room,
			[],
		);
		assert.equal(responses.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("branch provisioning rejects an advanced ref without durable room ownership", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "advanced-unowned-sha" } }),
	];
	globalThis.fetch = async () => responses.shift()!;
	try {
		await assert.rejects(ensureRoomBranches(githubEnv(), room, []), /not owned by this room/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("branch provisioning claims an unowned ref only at the exact selected base", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "base-sha" } }),
	];
	globalThis.fetch = async () => responses.shift()!;
	try {
		await ensureRoomBranches(githubEnv(), room, []);
		assert.equal(responses.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("branch provisioning accepts a creation race only after exact ref verification", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({}, { status: 404 }),
		Response.json({}, { status: 422 }),
		Response.json({ object: { sha: "base-sha" } }),
	];
	globalThis.fetch = async () => responses.shift()!;
	try {
		await ensureRoomBranches(githubEnv(), room, []);
		assert.equal(responses.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("branch provisioning heartbeats across network-bound preparation", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({}, { status: 404 }),
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "base-sha" } }),
	];
	let heartbeats = 0;
	globalThis.fetch = async () => responses.shift()!;
	try {
		await ensureRoomBranches(githubEnv(), room, [], async () => {
			heartbeats += 1;
		});
		assert.equal(responses.length, 0);
		assert.ok(heartbeats >= 6);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
