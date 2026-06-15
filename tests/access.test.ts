import assert from "node:assert/strict";
import test from "node:test";

import { activeRoomLimit, eventAccessAuthorized } from "../src/access.ts";

test("event admission uses fixed-length comparisons and active-room limits stay bounded", async () => {
	assert.equal(await eventAccessAuthorized("event", "event"), true);
	assert.equal(await eventAccessAuthorized("event", "event-wrong"), false);
	assert.equal(await eventAccessAuthorized("event", undefined), false);
	assert.equal(await eventAccessAuthorized(null, "event"), false);
	assert.equal(activeRoomLimit(undefined), 20);
	assert.equal(activeRoomLimit("0"), 1);
	assert.equal(activeRoomLimit("999"), 100);
});
