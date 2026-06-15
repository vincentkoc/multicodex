import assert from "node:assert/strict";
import test from "node:test";

import {
	maxRoomWebSockets,
	recordSocketMessage,
	sameOriginWebSocketRequest,
} from "../src/socket-admission.ts";

test("websocket admission requires the exact request origin", () => {
	assert.equal(
		sameOriginWebSocketRequest(
			new Request("https://multicodex.example/api/rooms/room/ws", {
				headers: { origin: "https://multicodex.example" },
			}),
		),
		true,
	);
	assert.equal(
		sameOriginWebSocketRequest(
			new Request("https://multicodex.example/api/rooms/room/ws", {
				headers: { origin: "https://attacker.example" },
			}),
		),
		false,
	);
	assert.equal(
		sameOriginWebSocketRequest(new Request("https://multicodex.example/api/rooms/room/ws")),
		false,
	);
});

test("websocket message rate state closes sustained ping traffic", () => {
	let state = null;
	for (let count = 0; count < 30; count += 1) {
		const result = recordSocketMessage(state, 1_000);
		assert.equal(result.allowed, true);
		state = result.state;
	}
	assert.equal(recordSocketMessage(state, 1_000).allowed, false);
	assert.equal(recordSocketMessage(state, 11_000).allowed, true);
});

test("each room has a conservative websocket admission cap", () => {
	assert.equal(maxRoomWebSockets, 64);
});
