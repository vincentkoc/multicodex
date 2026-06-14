import assert from "node:assert/strict";
import test from "node:test";

import type { RoomSnapshot } from "../src/domain.ts";
import { snapshotForViewer } from "../src/visibility.ts";

const snapshot = {
	room: {
		id: "room",
		slug: "room",
		title: "Room",
		status: "building",
		hostParticipantId: "host",
		repo: "example/repo",
		baseBranch: "main",
		integrationBranch: "multicodex/room/integration",
		crabfleetRootSessionId: "root-secret",
		brief: {},
		briefRevision: 1,
		durationMinutes: 10,
		startedAt: 1,
		endsAt: 2,
		createdAt: 1,
		updatedAt: 1,
	},
	participants: ["host", "guest"].map((id) => ({
		id,
		roomId: "room",
		kind: "human" as const,
		displayName: id,
		githubLogin: null,
		roleId: null,
		taskId: null,
		crabfleetSessionId: `${id}-session-secret`,
		browserUrl: `https://runtime.example/${id}-secret`,
		runtimeSummary: `ready ${id}-session-secret under root-secret`,
		branch: `multicodex/room/${id}`,
		state: "ready" as const,
		joinedAt: 1,
		createdAt: 1,
		updatedAt: 1,
	})),
	messages: [
		{
			id: "message",
			roomId: "room",
			authorKind: "human" as const,
			authorId: "host",
			targetKind: "room" as const,
			targetId: null,
			body: "retired-runtime-secret must stay private",
			replyToId: null,
			createdAt: 1,
		},
	],
	messageCount: 1,
	tasks: [],
	decisions: [],
	conductorActions: [
		{
			id: "action",
			roomId: "room",
			kind: "session_nudge",
			targetIds: ["guest", "guest-session-secret"],
			reason: "align the contract",
			evidenceRefs: ["root-secret"],
			approvalState: "not_required",
			createdAt: 1,
		},
	],
	runtimeRedactions: ["retired-runtime-secret"],
} satisfies RoomSnapshot;

test("public snapshots hide every runtime capability", () => {
	const visible = snapshotForViewer(snapshot);
	assert.equal(visible.room.crabfleetRootSessionId, null);
	assert.ok(visible.participants.every((participant) => participant.crabfleetSessionId === null));
	assert.ok(visible.participants.every((participant) => participant.browserUrl === null));
	assert.deepEqual(visible.conductorActions[0]?.targetIds, ["guest"]);
	assert.deepEqual(visible.conductorActions[0]?.evidenceRefs, []);
	assert.deepEqual(visible.runtimeRedactions, []);
	assert.doesNotMatch(
		JSON.stringify(visible),
		/root-secret|host-session-secret|guest-session-secret|retired-runtime-secret/,
	);
});

test("participants only receive their own workspace URL", () => {
	const visible = snapshotForViewer(snapshot, "guest");
	assert.equal(
		visible.participants.find((participant) => participant.id === "host")?.browserUrl,
		null,
	);
	assert.equal(
		visible.participants.find((participant) => participant.id === "guest")?.browserUrl,
		"https://runtime.example/guest-secret",
	);
	assert.ok(visible.participants.every((participant) => participant.crabfleetSessionId === null));
	assert.doesNotMatch(
		visible.participants.map((participant) => participant.runtimeSummary).join(" "),
		/root-secret|session-secret/,
	);
});
