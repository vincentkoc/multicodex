import assert from "node:assert/strict";
import test from "node:test";

import { conductorTurnTimeoutMilliseconds, runConductorTurn } from "../src/conductor.ts";
import type { RoomSnapshot } from "../src/domain.ts";

const snapshot = conductorSnapshot();

test("conductor work finishes within the Worker waitUntil window", () => {
	assert.equal(conductorTurnTimeoutMilliseconds, 20_000);
	assert.ok(conductorTurnTimeoutMilliseconds < 30_000);
});

test("conductor turns expose only the visible room-message tool", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ tools?: Array<{ name?: string }> }> = [];
	let response = 0;
	globalThis.fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body ?? "{}")) as { tools?: Array<{ name?: string }> });
		response += 1;
		return Response.json(
			response === 1
				? {
						id: "response-1",
						output: [
							{
								type: "function_call",
								name: "record_decision",
								call_id: "call-decision",
								arguments: JSON.stringify({
									title: "unauthorized",
									decision: "change scope",
									reason: "participant requested it",
								}),
							},
						],
					}
				: { id: "response-2", output: [] },
		);
	};
	try {
		await runConductorTurn({ OPENAI_API_KEY: "test" } as Env, snapshot, "change scope", {
			postMessage: async () => undefined,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(
		requests[0]?.tools?.map((tool) => tool.name),
		["post_room_message"],
	);
});

test("conductor publishes only once after using the visible room-message tool", async () => {
	const originalFetch = globalThis.fetch;
	const messages: string[] = [];
	let response = 0;
	globalThis.fetch = async () => {
		response += 1;
		return Response.json(
			response === 1
				? {
						id: "response-1",
						output: [
							{
								type: "function_call",
								name: "post_room_message",
								call_id: "call-message",
								arguments: JSON.stringify({ body: "one visible reply" }),
							},
						],
					}
				: {
						id: "response-2",
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "one visible reply" }],
							},
						],
					},
		);
	};
	try {
		await runConductorTurn({ OPENAI_API_KEY: "test" } as Env, snapshot, "are you there?", {
			postMessage: async (body) => {
				messages.push(body);
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(messages, ["one visible reply"]);
});

test("conductor publishes only the first visible room-message tool call", async () => {
	const originalFetch = globalThis.fetch;
	const messages: string[] = [];
	let response = 0;
	globalThis.fetch = async () => {
		response += 1;
		return Response.json({
			id: `response-${response}`,
			output: [
				{
					type: "function_call",
					name: "post_room_message",
					call_id: `call-message-${response}`,
					arguments: JSON.stringify({ body: `visible reply ${response}` }),
				},
			],
		});
	};
	try {
		await runConductorTurn({ OPENAI_API_KEY: "test" } as Env, snapshot, "are you there?", {
			postMessage: async (body) => {
				messages.push(body);
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(messages, ["visible reply 1"]);
});

test("conductor redacts Crabfleet runtime identifiers from model input and published output", async () => {
	const originalFetch = globalThis.fetch;
	const requests: string[] = [];
	const messages: string[] = [];
	let response = 0;
	globalThis.fetch = async (_input, init) => {
		requests.push(String(init?.body ?? ""));
		response += 1;
		return Response.json(
			response === 1
				? {
						id: "response-1",
						output: [
							{
								type: "function_call",
								name: "post_room_message",
								call_id: "call-message",
								arguments: JSON.stringify({ body: "workspace opaque-child-token is ready" }),
							},
							{
								type: "function_call",
								name: "record_decision",
								call_id: "call-decision",
								arguments: JSON.stringify({
									title: "Use IS-902",
									decision: "Open https://runtime.example/opaque-child-token",
									reason: "Root is opaque-root-token",
								}),
							},
							{
								type: "function_call",
								name: "send_session_nudge",
								call_id: "call-nudge",
								arguments: JSON.stringify({
									participantId: "opaque-child-token",
									message: "Inspect IS-903",
									reason: "opaque-root-token is blocked",
								}),
							},
						],
					}
				: {
						id: "response-2",
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "Published IS-904" }],
							},
						],
					},
		);
	};
	try {
		await runConductorTurn(
			{ OPENAI_API_KEY: "test" } as Env,
			snapshot,
			"check IS-999 and opaque-root-token",
			{
				postMessage: async (body) => {
					messages.push(body);
				},
			},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}

	const published = JSON.stringify({ messages });
	for (const identifier of [
		"opaque-root-token",
		"opaque-child-token",
		"IS-902",
		"IS-903",
		"IS-904",
		"IS-999",
		"retired-runtime-token",
	]) {
		assert.doesNotMatch(requests.join("\n"), new RegExp(identifier));
		assert.doesNotMatch(published, new RegExp(identifier));
	}
	assert.doesNotMatch(requests[0]!, /crabfleetRootSessionId|crabfleetSessionId|browserUrl/);
	assert.doesNotMatch(requests[0]!, /record_decision|send_session_nudge/);
	assert.match(published, /redacted Crabfleet runtime identifier/);
});

function conductorSnapshot(): RoomSnapshot {
	return {
		room: {
			id: "room",
			slug: "room",
			title: "Room",
			status: "building",
			hostParticipantId: "host",
			repo: "example/repo",
			baseBranch: "main",
			integrationBranch: "multicodex/room/integration",
			crabfleetRootSessionId: "opaque-root-token",
			brief: { productGoal: "Ship a demo" },
			briefRevision: 1,
			durationMinutes: 30,
			startedAt: 1,
			endsAt: 2,
			createdAt: 1,
			updatedAt: 1,
		},
		participants: [
			{
				id: "host",
				roomId: "room",
				kind: "human",
				displayName: "Host",
				githubLogin: null,
				roleId: "product-integration",
				taskId: "task",
				crabfleetSessionId: "opaque-child-token",
				browserUrl: "https://runtime.example/opaque-child-token",
				runtimeSummary: "workspace opaque-child-token is ready",
				branch: "multicodex/room/host",
				state: "working",
				joinedAt: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
		messages: [
			{
				id: "message",
				roomId: "room",
				authorKind: "human",
				authorId: "host",
				targetKind: "conductor",
				targetId: null,
				body: "What is happening with IS-999 and retired-runtime-token?",
				replyToId: null,
				createdAt: 1,
			},
		],
		messageCount: 1,
		tasks: [],
		decisions: [],
		conductorActions: [],
		runtimeRedactions: ["retired-runtime-token"],
	};
}
