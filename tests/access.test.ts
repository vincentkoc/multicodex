import assert from "node:assert/strict";
import test from "node:test";

import { activeRoomLimit, eventAccessAuthorized } from "../src/access.ts";

test("event admission fails closed and active-room limits stay bounded", () => {
	assert.equal(eventAccessAuthorized("event", "event"), true);
	assert.equal(eventAccessAuthorized("event", undefined), false);
	assert.equal(eventAccessAuthorized(null, "event"), false);
	assert.equal(activeRoomLimit(undefined), 20);
	assert.equal(activeRoomLimit("0"), 1);
	assert.equal(activeRoomLimit("999"), 100);
});
