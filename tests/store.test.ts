import assert from "node:assert/strict";
import test from "node:test";

import type { Participant } from "../src/domain.ts";
import { participantBranch, participantForTask } from "../src/store.ts";

const participant = (id: string, kind: Participant["kind"]): Participant => ({
	id,
	roomId: "room",
	kind,
	displayName: "Same Name",
	githubLogin: null,
	roleId: null,
	taskId: null,
	crabfleetSessionId: null,
	browserUrl: null,
	runtimeSummary: "",
	branch: `multicodex/room/${id}`,
	state: "joined",
	joinedAt: 1,
	createdAt: 1,
	updatedAt: 1,
});

test("participant branches remain unique for duplicate and reserved display names", () => {
	const first = participantBranch("room", "Same Name", "person-111111");
	const second = participantBranch("room", "Same Name", "person-222222");
	assert.notEqual(first, second);
	assert.ok(first.length <= 120);
	assert.notEqual(
		participantBranch("room", "integration", "person-111111"),
		"multicodex/room/integration",
	);
});

test("plan tasks resolve owners by participant id instead of list position", () => {
	const observer = participant("observer", "observer");
	const builder = participant("builder", "human");
	assert.equal(participantForTask([observer, builder], "builder")?.id, "builder");
});
