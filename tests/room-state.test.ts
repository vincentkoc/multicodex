import assert from "node:assert/strict";
import test from "node:test";

import {
	roomAllowsPlanning,
	roomAllowsPresentation,
	roomAllowsRuntimeNudge,
} from "../src/room-state.ts";

test("room lifecycle guards reject stale destructive actions", () => {
	assert.equal(roomAllowsPlanning("planning"), true);
	assert.equal(roomAllowsPlanning("building"), false);
	assert.equal(roomAllowsPlanning("ended"), false);
	assert.equal(roomAllowsPresentation("building"), true);
	assert.equal(roomAllowsPresentation("ended"), false);
	assert.equal(roomAllowsRuntimeNudge("integrating"), true);
	assert.equal(roomAllowsRuntimeNudge("presenting"), false);
});
