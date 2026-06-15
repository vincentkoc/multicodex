import assert from "node:assert/strict";
import test from "node:test";

import {
	builderRoomWebSocketTag,
	maxObserverRoomWebSockets,
	maxParticipantWebSockets,
	maxPublicRoomWebSockets,
	maxRoomWebSockets,
	observerRoomWebSocketTag,
	participantRoomWebSocketTag,
	publicRoomWebSocketTag,
	recordSocketMessage,
	sameOriginWebSocketRequest,
} from "../src/socket-admission.ts";
import { requestSourceKey } from "../src/source-key.ts";

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
	assert.equal(maxPublicRoomWebSockets, 16);
	assert.equal(maxObserverRoomWebSockets, 16);
	assert.equal(maxParticipantWebSockets, 4);
	assert.equal(publicRoomWebSocketTag, "public");
	assert.equal(observerRoomWebSocketTag, "observer");
	assert.equal(builderRoomWebSocketTag, "builder");
	assert.equal(participantRoomWebSocketTag("person-1"), "participant:person-1");
});

test("edge source identifiers are stable hashes rather than raw addresses", async () => {
	const first = await requestSourceKey(
		new Request("https://multicodex.example", {
			headers: { "cf-connecting-ip": "203.0.113.10" },
		}),
	);
	const second = await requestSourceKey(
		new Request("https://multicodex.example", {
			headers: { "cf-connecting-ip": "203.0.113.10" },
		}),
	);

	assert.equal(first, second);
	assert.match(first, /^[a-f0-9]{64}$/);
	assert.doesNotMatch(first, /203\.0\.113\.10/);
});
