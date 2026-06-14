import assert from "node:assert/strict";
import test from "node:test";

import type { Room } from "../src/domain.ts";
import { ensureRoomBranches, resolveRepoDefaultBranch } from "../src/github.ts";

const room = {
	repo: "example/repo",
	baseBranch: "main",
	integrationBranch: "multicodex/room/integration",
} as Room;

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

test("branch provisioning safely reuses a room-owned ref after work advances it", async () => {
	const originalFetch = globalThis.fetch;
	const responses = [
		Response.json({ object: { sha: "base-sha" } }),
		Response.json({ object: { sha: "advanced-room-sha" } }),
	];
	globalThis.fetch = async () => responses.shift()!;
	try {
		await ensureRoomBranches({ GITHUB_TOKEN: "token" } as Env, room, []);
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
		await ensureRoomBranches({ GITHUB_TOKEN: "token" } as Env, room, []);
		assert.equal(responses.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
