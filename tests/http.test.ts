import assert from "node:assert/strict";
import test from "node:test";

import {
	HttpError,
	optionalParticipantToken,
	participantToken,
	readBoundedText,
	readJson,
	slugify,
} from "../src/http.ts";

test("slugify creates stable branch-safe labels", () => {
	assert.equal(slugify("OpenAI Event Room!"), "openai-event-room");
	assert.equal(slugify("***", "seat"), "seat");
});

test("bounded request reader rejects oversized chunked input", async () => {
	const request = new Request("https://example.test", {
		method: "POST",
		duplex: "half",
		body: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("1234"));
				controller.enqueue(new TextEncoder().encode("5678"));
				controller.close();
			},
		}),
	} as RequestInit & { duplex: "half" });
	await assert.rejects(
		readBoundedText(request, 6),
		(error) => error instanceof HttpError && error.status === 413,
	);
});

test("JSON request reader requires an object payload", async () => {
	for (const body of ["null", "[]", '"text"', "42"]) {
		await assert.rejects(
			readJson(new Request("https://example.test", { method: "POST", body })),
			(error) => error instanceof HttpError && error.status === 400,
		);
	}
	assert.deepEqual(
		await readJson<{ ok: boolean }>(
			new Request("https://example.test", { method: "POST", body: '{"ok":true}' }),
		),
		{ ok: true },
	);
});

test("participant capability only accepts bearer credentials", () => {
	assert.equal(
		participantToken(
			new Request("https://example.test", { headers: { authorization: "Bearer seat_secret" } }),
		),
		"seat_secret",
	);
	assert.equal(optionalParticipantToken(new Request("https://example.test")), null);
	assert.throws(
		() =>
			participantToken(
				new Request("https://example.test", {
					headers: { "x-multicodex-participant-id": "public_person_id" },
				}),
			),
		(error) => error instanceof HttpError && error.status === 401,
	);
});
