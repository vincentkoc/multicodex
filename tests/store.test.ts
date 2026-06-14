import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("builder joins atomically invalidate stale plans and enforce the five-seat cap", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function addParticipant");
	const end = source.indexOf("export async function requireRoomParticipant", start);
	const addParticipantSource = source.slice(start, end);

	assert.match(addParticipantSource, /input\.kind === "observer" \? 24 : 5/);
	assert.match(
		addParticipantSource,
		/status NOT IN \('cleanup-planning', 'cleanup-ending', 'ended'\)/,
	);
	assert.match(addParticipantSource, /DELETE FROM tasks/);
	assert.match(addParticipantSource, /SET task_id = NULL/);
	assert.match(addParticipantSource, /brief_revision = brief_revision \+ 1/);
	assert.match(addParticipantSource, /const \[result\] = await db\.batch\(statements\)/);
});

test("task updates are atomically fenced against terminal rooms", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function updateTaskState");
	const end = source.indexOf("export async function addDecision", start);
	const taskSource = source.slice(start, end);

	assert.match(taskSource, /EXISTS \(/);
	assert.match(taskSource, /status IN/);
	assert.match(taskSource, /AND state = \?/);
	assert.match(taskSource, /expectedState/);
	assert.match(taskSource, /return result\.meta\.changes === 1/);
});

test("plan approval atomically binds the validated revision and participant coverage", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function approveRoomPlan");
	const end = source.indexOf("export async function resetRoomProvisioning", start);
	const approvalSource = source.slice(start, end);

	assert.match(approvalSource, /brief_revision = \?/);
	assert.match(approvalSource, /COUNT\(\*\) FROM tasks/);
	assert.match(approvalSource, /participant\.kind != 'observer'/);
	assert.match(approvalSource, /task\.owner_participant_id = participant\.id/);
});

test("conductor claims atomically enforce room cooldown and hourly budget", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function claimConductorTurn");
	const end = source.indexOf("export async function endRoom", start);
	const claimSource = source.slice(start, end);

	assert.match(claimSource, /INSERT INTO conductor_actions/);
	assert.match(claimSource, /kind = 'conductor_turn' AND created_at > \?/);
	assert.match(claimSource, /\) < 12/);
	assert.match(claimSource, /status NOT IN \('cleanup-planning', 'cleanup-ending', 'ended'\)/);
});
