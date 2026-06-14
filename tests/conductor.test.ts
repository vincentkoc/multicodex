import assert from "node:assert/strict";
import test from "node:test";

import { conductorCanNudge } from "../src/conductor.ts";
import type { RoomSnapshot } from "../src/domain.ts";

const snapshot = {
	room: { hostParticipantId: "host" },
} as RoomSnapshot;

test("only the host can authorize conductor workspace nudges", () => {
	assert.equal(conductorCanNudge(snapshot, "host"), true);
	assert.equal(conductorCanNudge(snapshot, "guest"), false);
});
