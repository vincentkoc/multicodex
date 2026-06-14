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
		runtimeSummary: "ready",
		branch: `multicodex/room/${id}`,
		state: "ready" as const,
		joinedAt: 1,
		createdAt: 1,
		updatedAt: 1,
	})),
	messages: [],
	tasks: [],
	decisions: [],
	conductorActions: [],
} satisfies RoomSnapshot;

test("public snapshots hide every runtime capability", () => {
	const visible = snapshotForViewer(snapshot);
	assert.equal(visible.room.crabfleetRootSessionId, null);
	assert.ok(visible.participants.every((participant) => participant.crabfleetSessionId === null));
	assert.ok(visible.participants.every((participant) => participant.browserUrl === null));
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
});
