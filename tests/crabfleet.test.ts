import assert from "node:assert/strict";
import test from "node:test";

import {
	AmbiguousRootProvisioningError,
	crabfleetOwner,
	crabfleetRuntime,
	crabfleetSimulationEnabled,
	createCrabboxEmbedUrl,
	definitiveCrabfleetReplayConflict,
	participantStateForCrabfleetStatus,
	parseRootCrabboxRequest,
	PartialProvisioningError,
	provisionParticipantCrabbox,
	provisionRoomCrabboxes,
	readRoomCrabboxes,
	readinessDeadlineMilliseconds,
	readinessPollDelays,
	recoverRoomRootCrabbox,
	roomRootCrabboxRequest,
	sendCrabboxNudge,
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

test("workspace embed URLs are minted with the room root and service credential", async () => {
	const originalFetch = globalThis.fetch;
	let request: { url: string; authorization: string | null; body: unknown } | null = null;
	globalThis.fetch = async (input, init) => {
		request = {
			url: String(input),
			authorization: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(String(init?.body)),
		};
		return Response.json({
			browserUrl: "https://crabfleet.example/app/sessions/child?token=signed",
			expiresAt: Date.now() + 60_000,
		});
	};
	try {
		assert.equal(
			await createCrabboxEmbedUrl(
				{
					CRABFLEET_API_URL: "https://crabfleet.example",
					CRABFLEET_SERVICE_TOKEN: "service-secret",
				} as unknown as Env,
				"root",
				"child",
			),
			"https://crabfleet.example/app/sessions/child?token=signed",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(request, {
		url: "https://crabfleet.example/api/openclaw/crabboxes/child/embed-ticket",
		authorization: "Bearer service-secret",
		body: { rootSessionId: "root", ttlSeconds: 3_600 },
	});
});

test("workspace embed URLs reject invalid Crabfleet responses", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ browserUrl: "javascript:alert(1)" });
	try {
		await assert.rejects(
			createCrabboxEmbedUrl({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", "child"),
			/invalid embed ticket/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("readiness polling covers Crabbox cold starts while preserving subrequest headroom", () => {
	assert.deepEqual(
		readinessPollDelays,
		[1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 32_000],
	);
	assert.equal(readinessPollDelays.length, 10);
	assert.ok(
		readinessPollDelays.reduce((total, delay) => total + delay, 0) < readinessDeadlineMilliseconds,
	);
	assert.ok(readinessDeadlineMilliseconds < 180_000);
});

test("partial room provisioning returns every created session for durable cleanup", async () => {
	const originalFetch = globalThis.fetch;
	let creates = 0;
	const owners: string[] = [];
	const requestIds: string[] = [];
	const persisted: string[] = [];
	const persistedStages: string[] = [];
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
				{
					CRABFLEET_OWNER: "Event Service",
					CRABFLEET_SERVICE_TOKEN: "test",
				} as unknown as Env,
				room,
				[
					{ ...participant("host"), githubLogin: "untrusted-host" },
					{ ...participant("child"), githubLogin: "untrusted-child" },
					participant("failure"),
				],
				[],
				async ({ binding }, _bindings, stage) => {
					persisted.push(binding.session.id);
					persistedStages.push(stage);
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
	assert.deepEqual(persistedStages, ["created", "created"]);
});

test("ambiguous root provisioning replays the persisted request after config drift", async () => {
	const originalFetch = globalThis.fetch;
	const requestIds: string[] = [];
	const requestBodies: unknown[] = [];
	let attempts = 0;
	globalThis.fetch = async (_input, init) => {
		attempts += 1;
		const body = JSON.parse(String(init?.body)) as { requestId: string };
		requestIds.push(body.requestId);
		requestBodies.push(body);
		if (attempts === 1) throw new Error("response lost");
		return Response.json(crabbox("root", "ready"));
	};
	const originalEnv = {
		CRABFLEET_OWNER: "Original Owner",
		CRABFLEET_PROFILE: "original-profile",
		CRABFLEET_RUNTIME: "container",
		CRABFLEET_SERVICE_TOKEN: "test",
	} as unknown as Env;
	const persisted = JSON.stringify(
		roomRootCrabboxRequest(originalEnv, room, [participant("host")], []),
	);
	try {
		await assert.rejects(
			provisionRoomCrabboxes(
				originalEnv,
				room,
				[participant("host")],
				[],
				undefined,
				parseRootCrabboxRequest(persisted),
			),
			(error) => error instanceof AmbiguousRootProvisioningError,
		);
		const recovered = await recoverRoomRootCrabbox(
			{
				CRABFLEET_OWNER: "Changed Owner",
				CRABFLEET_PROFILE: "changed-profile",
				CRABFLEET_RUNTIME: "crabbox",
				CRABFLEET_SERVICE_TOKEN: "test",
			} as unknown as Env,
			{ ...room, updatedAt: 999 },
			[participant("host")],
			[],
			parseRootCrabboxRequest(persisted),
		);
		assert.equal(recovered.binding.session.id, "root");
	} finally {
		globalThis.fetch = originalFetch;
	}
	assert.deepEqual(requestIds, ["multicodex:room:1:host", "multicodex:room:1:host"]);
	assert.deepEqual(requestBodies[1], requestBodies[0]);
});

test("Crabfleet replay conflicts are definitive while preparing replays stay ambiguous", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response("conflict", { status: 409 });
		await assert.rejects(
			recoverRoomRootCrabbox(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			(error) => definitiveCrabfleetReplayConflict(error),
		);
		await assert.rejects(
			provisionRoomCrabboxes(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			(error) => {
				assert.ok(error instanceof PartialProvisioningError);
				assert.deepEqual(error.bindings, []);
				return true;
			},
		);

		globalThis.fetch = async () => new Response("still preparing", { status: 503 });
		await assert.rejects(
			recoverRoomRootCrabbox(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			(error) => !definitiveCrabfleetReplayConflict(error),
		);
		await assert.rejects(
			provisionRoomCrabboxes(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			(error) => error instanceof AmbiguousRootProvisioningError,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("persisted root requests fail closed when corrupted", () => {
	assert.throws(() => parseRootCrabboxRequest("{}"), /persisted root Crabfleet request is invalid/);
	assert.throws(
		() => parseRootCrabboxRequest('{"participantId":"host","body":{"runtime":"unknown"}}'),
		/persisted root Crabfleet request is invalid/,
	);
});

test("persisted root requests remain bound to the room host", async () => {
	const env = { CRABFLEET_SERVICE_TOKEN: "test" } as Env;
	const request = roomRootCrabboxRequest(env, room, [participant("host")], []);
	await assert.rejects(
		recoverRoomRootCrabbox(env, room, [participant("host")], [], {
			...request,
			participantId: "other",
		}),
		/does not match the room host/,
	);
});

test("Crabfleet create responses require a valid workspace binding", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({
			session: {
				id: "",
				rootSessionId: null,
				status: "ready",
				summary: "ready",
				purpose: "task",
			},
			browserUrl: "https://example.test/root",
		});
	try {
		await assert.rejects(
			recoverRoomRootCrabbox(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host")],
				[],
			),
			/invalid workspace binding/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Crabfleet child bindings must belong to the requested root", async () => {
	const originalFetch = globalThis.fetch;
	let creates = 0;
	globalThis.fetch = async () => {
		creates += 1;
		return Response.json(
			creates === 1
				? crabbox("root", "ready")
				: {
						...crabbox("child", "ready"),
						session: { ...crabbox("child", "ready").session, rootSessionId: "other-root" },
					},
		);
	};
	try {
		await assert.rejects(
			provisionRoomCrabboxes(
				{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
				room,
				[participant("host"), participant("child")],
				[],
			),
			(error) => {
				assert.ok(error instanceof PartialProvisioningError);
				assert.deepEqual(
					error.bindings.map(({ binding }) => binding.session.id),
					["root"],
				);
				return true;
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("participant repair provisions a replacement under the existing room root", async () => {
	const originalFetch = globalThis.fetch;
	let request: Record<string, unknown> | null = null;
	globalThis.fetch = async (input, init) => {
		assert.equal(new URL(String(input)).pathname, "/api/openclaw/crabboxes");
		request = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Response.json(crabbox("replacement", "ready"));
	};
	try {
		const target = { ...participant("child"), crabfleetSessionId: "stale" };
		const binding = await provisionParticipantCrabbox(
			{ CRABFLEET_SERVICE_TOKEN: "test" } as Env,
			{ ...room, status: "building", crabfleetRootSessionId: "root" },
			target,
			undefined,
			"stale",
		);
		assert.equal(binding.participantId, "child");
		assert.equal(binding.binding.session.id, "replacement");
		assert.deepEqual(request, {
			owner: "multicodex",
			repo: "example/repo",
			branch: "multicodex/room/child",
			baseBranch: "main",
			requestId: "multicodex:room:repair:child:stale",
			parentSessionId: "root",
			rootSessionId: "root",
			purpose: "room task",
			summary: "repairing assigned task",
			prompt: "Resume your assigned room task from the current branch.",
			runtime: "crabbox",
			profile: "default",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
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

test("explicit simulation never calls Crabfleet even when credentials exist", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		throw new Error("Crabfleet must not be called");
	};
	const env = {
		CRABFLEET_SERVICE_TOKEN: "configured-but-unused",
		MULTICODEX_SIMULATION_MODE: "true",
	} as unknown as Env;
	try {
		const bindings = await provisionRoomCrabboxes(env, room, [participant("host")], []);
		assert.match(bindings[0]!.binding.session.id, /^SIM-/);
		assert.match(
			(await recoverRoomRootCrabbox(env, room, [participant("host")], [])).binding.session.id,
			/^SIM-/,
		);
		assert.deepEqual(await readRoomCrabboxes(env, "root"), []);
		await sendCrabboxNudge(env, "root", "child", "stay simulated");
		await stopRoomCrabboxes(env, "root", ["root", "child"]);
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
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

test("Crabfleet cleanup accepts previously finalized children absent from the root tree", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({
			rootSessionId: "root",
			admissionClosed: true,
			crabboxes: [crabbox("root", "stopped")],
		});
	try {
		await stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root", "child"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Crabfleet cleanup requires the root session to remain in the terminal tree", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({
			rootSessionId: "root",
			admissionClosed: true,
			crabboxes: [crabbox("child", "stopped")],
		});
	try {
		await assert.rejects(
			stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root", "child"]),
			/cleanup did not reach a terminal state/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Crabfleet cleanup rejects returned non-terminal sessions", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		Response.json({
			rootSessionId: "root",
			admissionClosed: true,
			crabboxes: [crabbox("root", "stopped"), crabbox("child", "attached")],
		});
	try {
		await assert.rejects(
			stopRoomCrabboxes({ CRABFLEET_SERVICE_TOKEN: "test" } as Env, "root", ["root", "child"]),
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
	const persistedStages: string[] = [];
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
			async (_binding, _bindings, stage) => {
				persistedStages.push(stage);
			},
		);
		assert.equal(bindings[0]?.binding.session.status, "attached");
		assert.deepEqual(persistedStages, ["created", "ready"]);
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

test("Crabfleet requests preserve configured gateway path prefixes", async () => {
	const originalFetch = globalThis.fetch;
	let requestUrl = "";
	globalThis.fetch = async (input) => {
		requestUrl = String(input);
		return Response.json({ crabboxes: [] });
	};
	try {
		await readRoomCrabboxes(
			{
				CRABFLEET_API_URL: "https://gateway.example/internal/crabfleet/",
				CRABFLEET_SERVICE_TOKEN: "test",
			} as unknown as Env,
			"root",
		);
		assert.equal(
			new URL(requestUrl).pathname,
			"/internal/crabfleet/api/openclaw/session-roots/root",
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
