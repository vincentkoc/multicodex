import assert from "node:assert/strict";
import test from "node:test";

import {
	crabfleetOwner,
	crabfleetRuntime,
	crabfleetSimulationEnabled,
	PartialProvisioningError,
	provisionRoomCrabboxes,
	readRoomCrabboxes,
	stopRoomCrabboxes,
} from "../src/crabfleet.ts";
import type { Participant, Room } from "../src/domain.ts";

test("Crabfleet runtime selection keeps crabbox as the conservative fallback", () => {
	assert.equal(crabfleetRuntime("container"), "container");
	assert.equal(crabfleetRuntime("crabbox"), "crabbox");
	assert.equal(crabfleetRuntime(undefined), "crabbox");
	assert.equal(crabfleetRuntime("unknown"), "crabbox");
	assert.equal(crabfleetOwner(undefined), "multicodex");
	assert.equal(crabfleetOwner("Event Service"), "event-service");
	assert.equal(crabfleetSimulationEnabled("true"), true);
	assert.equal(crabfleetSimulationEnabled(undefined), false);
});

test("partial room provisioning returns every created session for durable cleanup", async () => {
	const originalFetch = globalThis.fetch;
	let creates = 0;
	const owners: string[] = [];
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/crabboxes" && init?.method === "POST") {
			creates += 1;
			owners.push((JSON.parse(String(init.body)) as { owner: string }).owner);
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
				{ CRABFLEET_OWNER: "Event Service", CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[
					{ ...participant("host"), githubLogin: "untrusted-host" },
					{ ...participant("child"), githubLogin: "untrusted-child" },
					participant("failure"),
				],
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
	assert.deepEqual(owners, ["event-service", "event-service", "event-service"]);
});

test("room cleanup discovers late child sessions and waits for terminal state", async () => {
	const originalFetch = globalThis.fetch;
	const stopped = new Set<string>();
	let reads = 0;
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/session-roots/root") {
			reads += 1;
			const ids = reads >= 2 ? ["root", "child", "late-child"] : ["root", "child"];
			return Response.json({
				crabboxes: ids.map((id) => crabbox(id, stopped.has(id) ? "stopped" : "ready")),
			});
		}
		const action = path.match(/^\/api\/openclaw\/crabboxes\/([^/]+)\/actions$/);
		if (action && init?.method === "POST") {
			const id = decodeURIComponent(action[1]!);
			stopped.add(id);
			return Response.json(crabbox(id, "stopped"));
		}
		return new Response("not found", { status: 404 });
	};
	try {
		await stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root"]);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual([...stopped].sort(), ["child", "late-child", "root"]);
	assert.ok(reads >= 4);
});

test("Crabfleet cleanup fails closed without credentials unless simulation is explicit", async () => {
	await assert.rejects(stopRoomCrabboxes({} as Env, "root", ["root"]), /token is not configured/);
	await stopRoomCrabboxes({ MULTICODEX_SIMULATION_MODE: "true" } as unknown as Env, "root", [
		"root",
	]);
});

test("terminal Crabfleet create responses fail launch with cleanup evidence", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json(crabbox("root", "failed"));
	try {
		await assert.rejects(
			provisionRoomCrabboxes(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			(error) => {
				assert.ok(error instanceof PartialProvisioningError);
				assert.deepEqual(
					error.bindings.map(({ binding }) => binding.session.status),
					["failed"],
				);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("pending Crabfleet sessions must become ready before launch", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/crabboxes" && init?.method === "POST") {
			return Response.json(crabbox("root", "provisioning"));
		}
		if (path === "/api/openclaw/session-roots/root") {
			return Response.json({ crabboxes: [crabbox("root", "ready")] });
		}
		return new Response("not found", { status: 404 });
	};
	try {
		const bindings = await provisionRoomCrabboxes(
			{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
			room,
			[participant("host")],
			[],
		);
		assert.equal(bindings[0]?.binding.session.status, "ready");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Crabfleet upstream errors do not expose response bodies", async () => {
	const originalFetch = globalThis.fetch;
	const originalError = console.error;
	globalThis.fetch = async () =>
		new Response("opaque-root-token internal failure", { status: 500 });
	console.error = () => undefined;
	try {
		await assert.rejects(
			readRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root"),
			(error) => {
				assert.ok(error instanceof Error);
				assert.doesNotMatch(error.message, /opaque-root-token|internal failure/);
				assert.match(error.message, /Crabfleet request failed \(500\)/);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
		console.error = originalError;
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

function crabbox(id: string, status: string) {
	return {
		session: {
			id,
			rootSessionId: id === "root" ? null : "root",
			status,
			summary: status,
			purpose: "task",
		},
		browserUrl: `https://example.test/${id}`,
	};
}
