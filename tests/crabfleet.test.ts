import assert from "node:assert/strict";
import test from "node:test";

import {
	crabfleetRuntime,
	PartialProvisioningError,
	provisionRoomCrabboxes,
} from "../src/crabfleet.ts";
import type { Participant, Room } from "../src/domain.ts";

test("Crabfleet runtime selection keeps crabbox as the conservative fallback", () => {
	assert.equal(crabfleetRuntime("container"), "container");
	assert.equal(crabfleetRuntime("crabbox"), "crabbox");
	assert.equal(crabfleetRuntime(undefined), "crabbox");
	assert.equal(crabfleetRuntime("unknown"), "crabbox");
});

test("partial room provisioning returns every created session for durable cleanup", async () => {
	const originalFetch = globalThis.fetch;
	let creates = 0;
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/crabboxes" && init?.method === "POST") {
			creates += 1;
			if (creates === 3) return new Response("provisioning failed", { status: 500 });
			const id = creates === 1 ? "root" : "child";
			return Response.json({
				session: {
					id,
					rootSessionId: creates === 1 ? null : "root",
					status: "ready",
					summary: "ready",
					purpose: "task",
				},
				browserUrl: `https://example.test/${id}`,
			});
		}
		return new Response("not found", { status: 404 });
	};
	try {
		await assert.rejects(
			provisionRoomCrabboxes(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host"), participant("child"), participant("failure")],
				[],
			),
			(error) => {
				assert.ok(error instanceof PartialProvisioningError);
				assert.deepEqual(
					error.bindings.map(({ binding }) => binding.session.id),
					["root", "child"],
				);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const room: Room = {
	id: "room",
	slug: "room",
	title: "Room",
	status: "provisioning",
	hostParticipantId: "host",
	repo: "example/repo",
	baseBranch: "main",
	integrationBranch: "multicodex/room/integration",
	crabfleetRootSessionId: null,
	brief: {},
	briefRevision: 1,
	durationMinutes: 30,
	startedAt: 1,
	endsAt: 2,
	createdAt: 1,
	updatedAt: 1,
};

function participant(id: string): Participant {
	return {
		id,
		roomId: "room",
		kind: "human",
		displayName: id,
		githubLogin: null,
		roleId: null,
		taskId: null,
		crabfleetSessionId: null,
		browserUrl: null,
		runtimeSummary: "",
		branch: `multicodex/room/${id}`,
		state: "joined",
		joinedAt: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}
