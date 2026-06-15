import assert from "node:assert/strict";
import test from "node:test";

import { activeRoomLimit, eventAccessAuthorized } from "../src/access.ts";

test("event admission uses fixed-length comparisons and active-room limits stay bounded", async () => {
	const capability = "event-capability-with-at-least-32-bytes";
	assert.equal(await eventAccessAuthorized(capability, capability), true);
	assert.equal(await eventAccessAuthorized(capability, `${capability}-wrong`), false);
	assert.equal(await eventAccessAuthorized("short", "short"), false);
	assert.equal(await eventAccessAuthorized("event", undefined), false);
	assert.equal(await eventAccessAuthorized(null, "event"), false);
	assert.equal(activeRoomLimit(undefined), 20);
	assert.equal(activeRoomLimit("0"), 1);
	assert.equal(activeRoomLimit("999"), 100);
});
