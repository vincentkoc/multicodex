import assert from "node:assert/strict";
import test from "node:test";

import { resolveRepoDefaultBranch } from "../src/github.ts";

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
