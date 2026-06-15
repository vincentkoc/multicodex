import assert from "node:assert/strict";
import test from "node:test";

import { activeRoomLimit, applyEventAccessAttempt, eventAccessAuthorized } from "../src/access.ts";

test("event admission uses fixed-length comparisons and active-room limits stay bounded", async () => {
	assert.equal(await eventAccessAuthorized("event", "event"), true);
	assert.equal(await eventAccessAuthorized("event", "event-wrong"), false);
	assert.equal(await eventAccessAuthorized("event", undefined), false);
	assert.equal(await eventAccessAuthorized(null, "event"), false);
	assert.equal(activeRoomLimit(undefined), 20);
	assert.equal(activeRoomLimit("0"), 1);
	assert.equal(activeRoomLimit("999"), 100);
});

test("event admission blocks repeated failures by source and resets after success", () => {
	let state = null;
	for (let count = 0; count < 4; count += 1) {
		const result = applyEventAccessAttempt(state, false, 1_000 + count);
		assert.equal(result.authorized, false);
		assert.equal(result.state?.blockedUntil, 0);
		state = result.state;
	}
	const blocked = applyEventAccessAttempt(state, false, 2_000);
	assert.equal(blocked.authorized, false);
	assert.equal(blocked.state?.failedAttempts, 5);
	assert.ok((blocked.state?.blockedUntil ?? 0) > 2_000);
	assert.equal(applyEventAccessAttempt(blocked.state, true, 2_001).authorized, false);
	const recovered = applyEventAccessAttempt(blocked.state, true, blocked.state!.blockedUntil);
	assert.equal(recovered.authorized, true);
	assert.equal(recovered.state, null);
});
