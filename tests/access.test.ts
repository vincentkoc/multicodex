import assert from "node:assert/strict";
import test from "node:test";

import { activeRoomLimit } from "../src/access.ts";

test("active-room limits stay bounded", () => {
	assert.equal(activeRoomLimit(undefined), 20);
	assert.equal(activeRoomLimit("0"), 1);
	assert.equal(activeRoomLimit("999"), 100);
});
