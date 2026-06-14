import assert from "node:assert/strict";
import test from "node:test";

import {
	crabfleetOwner,
	crabfleetRuntime,
	crabfleetSimulationEnabled,
	participantStateForCrabfleetStatus,
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
	assert.equal(participantStateForCrabfleetStatus("ready", "joined"), "working");
	assert.equal(participantStateForCrabfleetStatus("attached", "joined"), "working");
	assert.equal(participantStateForCrabfleetStatus("detached", "joined"), "working");
	assert.equal(participantStateForCrabfleetStatus("failed", "working"), "blocked");
	assert.equal(participantStateForCrabfleetStatus("expired", "working"), "left");
	assert.equal(participantStateForCrabfleetStatus("stopped", "working"), "left");
	assert.equal(participantStateForCrabfleetStatus("provisioning", "joined"), "joined");
});

test("partial room provisioning returns every created session for durable cleanup", async () => {
	const originalFetch = globalThis.fetch;
	let creates = 0;
	const owners: string[] = [];
	const requestIds: string[] = [];
	const persisted: string[] = [];
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/crabboxes" && init?.method === "POST") {
			creates += 1;
			const body = JSON.parse(String(init.body)) as { owner: string; requestId: string };
			owners.push(body.owner);
			requestIds.push(body.requestId);
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
				async ({ binding }) => {
					persisted.push(binding.session.id);
				},
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
	assert.deepEqual(requestIds, [
		"multicodex:room:1:host",
		"multicodex:room:1:child",
		"multicodex:room:1:failure",
	]);
	assert.deepEqual(persisted, ["root", "child"]);
});

test("room cleanup delegates admission freeze and recursive stop to the root action", async () => {
	const originalFetch = globalThis.fetch;
	let rootStops = 0;
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/session-roots/root/actions" && init?.method === "POST") {
			rootStops += 1;
			assert.deepEqual(JSON.parse(String(init.body)), { action: "stop" });
			return Response.json({
				rootSessionId: "root",
				admissionClosed: true,
				crabboxes: ["root", "child", "late-child"].map((id) => crabbox(id, "stopped")),
			});
		}
		return new Response("not found", { status: 404 });
	};
	try {
		await stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root"]);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(rootStops, 1);
});

test("Crabfleet cleanup fails closed without credentials unless simulation is explicit", async () => {
	await assert.rejects(stopRoomCrabboxes({} as Env, "root", ["root"]), /token is not configured/);
	await stopRoomCrabboxes({ MULTICODEX_SIMULATION_MODE: "true" } as unknown as Env, "root", [
		"root",
	]);
});

test("Crabfleet cleanup fails closed on an incomplete root-stop response", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ rootSessionId: "root", admissionClosed: true });
	try {
		await assert.rejects(
			stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root"]),
			/cleanup did not reach a terminal state/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
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

test("pending Crabfleet sessions accept any usable state before launch", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/api/openclaw/crabboxes" && init?.method === "POST") {
			return Response.json(crabbox("root", "provisioning"));
		}
		if (path === "/api/openclaw/session-roots/root") {
			return Response.json({ crabboxes: [crabbox("root", "attached")] });
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
		assert.equal(bindings[0]?.binding.session.status, "attached");
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
