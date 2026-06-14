import assert from "node:assert/strict";
import test from "node:test";

import {
	roomAllowsPlanning,
	roomAllowsPresentation,
	roomAllowsMessages,
	roomAllowsRuntimeRefresh,
	roomAllowsRuntimeNudge,
	roomPlanCoversActiveParticipants,
} from "../src/room-state.ts";
import type { RoomSnapshot } from "../src/domain.ts";

test("room lifecycle guards reject stale destructive actions", () => {
	assert.equal(roomAllowsPlanning("planning"), true);
	assert.equal(roomAllowsPlanning("building"), false);
	assert.equal(roomAllowsPlanning("cleanup-planning"), false);
	assert.equal(roomAllowsPlanning("ended"), false);
	assert.equal(roomAllowsPresentation("building"), true);
	assert.equal(roomAllowsPresentation("cleanup-ending"), false);
	assert.equal(roomAllowsPresentation("ended"), false);
	assert.equal(roomAllowsRuntimeNudge("integrating"), true);
	assert.equal(roomAllowsRuntimeNudge("presenting"), false);
	assert.equal(roomAllowsRuntimeRefresh("presenting"), true);
	assert.equal(roomAllowsRuntimeRefresh("ended"), false);
	assert.equal(roomAllowsMessages("presenting"), true);
	assert.equal(roomAllowsMessages("cleanup-planning"), false);
	assert.equal(roomAllowsMessages("cleanup-ending"), false);
	assert.equal(roomAllowsMessages("ended"), false);
});

test("plan approval requires one current role and owned task per active participant", () => {
	const snapshot = plannedSnapshot();
	assert.equal(roomPlanCoversActiveParticipants(snapshot), true);
	snapshot.participants.push({
		...snapshot.participants[0]!,
		id: "new-builder",
		displayName: "New builder",
		roleId: null,
		taskId: null,
	});
	assert.equal(roomPlanCoversActiveParticipants(snapshot), false);
	snapshot.participants.at(-1)!.kind = "observer";
	assert.equal(roomPlanCoversActiveParticipants(snapshot), true);
});

function plannedSnapshot(): RoomSnapshot {
	return {
		room: {
			id: "room",
			slug: "room",
			title: "Room",
			status: "planning",
			hostParticipantId: "host",
			repo: "example/repo",
			baseBranch: "main",
			integrationBranch: "multicodex/room/integration",
			crabfleetRootSessionId: null,
			brief: {},
			briefRevision: 1,
			durationMinutes: 30,
			startedAt: null,
			endsAt: null,
			createdAt: 1,
			updatedAt: 1,
		},
		participants: [
			{
				id: "host",
				roomId: "room",
				kind: "human",
				displayName: "Host",
				githubLogin: null,
				roleId: "integration",
				taskId: "task",
				crabfleetSessionId: null,
				browserUrl: null,
				runtimeSummary: "",
				branch: "multicodex/room/integration",
				state: "joined",
				joinedAt: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
		messages: [],
		messageCount: 0,
		tasks: [
			{
				id: "task",
				roomId: "room",
				title: "Integrate",
				description: "Ship it",
				ownerParticipantId: "host",
				state: "planned",
				dependsOn: [],
				ownsPaths: [],
				acceptanceCriteria: [],
				branch: "multicodex/room/integration",
				pullRequestUrl: null,
				createdAt: 1,
				updatedAt: 1,
			},
		],
		decisions: [],
		conductorActions: [],
		runtimeRedactions: [],
	};
}
