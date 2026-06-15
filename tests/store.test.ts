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

test("room creation reservations fence external work to available capacity", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function reserveRoomCreation");
	const end = source.indexOf("export async function createRoom", start);
	const reservationSource = source.slice(start, end);

	assert.match(reservationSource, /DELETE FROM room_creation_reservations WHERE expires_at <= \?/);
	assert.match(reservationSource, /COUNT\(\*\) FROM rooms WHERE status != 'ended'/);
	assert.match(
		reservationSource,
		/COUNT\(\*\) FROM room_creation_reservations WHERE expires_at > \?/,
	);
	assert.match(reservationSource, /releaseRoomCreationReservation/);
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
	assert.match(addParticipantSource, /join_request_id = \?/);
	assert.match(addParticipantSource, /INSERT OR IGNORE INTO participants/);
	assert.match(
		addParticipantSource,
		/COUNT\(\*\) FROM participants WHERE room_id = \? AND kind = 'ai'/,
	);
	assert.match(addParticipantSource, /INSERT INTO room_messages/);
	assert.match(addParticipantSource, /UPDATE rooms SET updated_at = \?/);
	assert.match(addParticipantSource, /status IN \('setup', 'planning'\)/);
	assert.match(addParticipantSource, /participantReplay\(existing, input\)/);
	assert.match(addParticipantSource, /participantReplay\(replay, input\)/);
	assert.match(addParticipantSource, /const \[result\] = await db\.batch\(statements\)/);
});

test("join request replays preserve immutable seat identity", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("function participantReplay");
	const end = source.indexOf("function messageFromRow", start);
	const replaySource = source.slice(start, end);

	assert.match(replaySource, /row\.kind !== input\.kind/);
	assert.match(replaySource, /row\.display_name !== input\.displayName/);
	assert.match(replaySource, /row\.github_login !== \(input\.githubLogin \?\? null\)/);
	assert.match(replaySource, /join request does not match the original seat/);
});

test("room creation persists the resolved repository base branch", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function createRoom");
	const end = source.indexOf("export async function readRoomSnapshot", start);
	const createSource = source.slice(start, end);

	assert.match(createSource, /baseBranch: string/);
	assert.match(createSource, /input\.baseBranch/);
	assert.match(createSource, /replayCreatedRoom/);
	assert.match(createSource, /creation_request_id/);
	assert.match(createSource, /builder_invite_token/);
	assert.match(createSource, /builderInviteToken/);
	assert.match(createSource, /INSERT OR IGNORE INTO rooms/);
	assert.match(createSource, /replaceAll\("-", ""\)/);
	assert.match(createSource, /\.slice\(0, 20\)/);
	assert.match(createSource, /SELECT COUNT\(\*\) FROM rooms WHERE status != 'ended'/);
	assert.doesNotMatch(createSource, /UPDATE rooms SET status = 'ended'/);
	assert.doesNotMatch(createSource, /staleBefore/);
	assert.doesNotMatch(createSource, /'main'/);
});

test("room creation replay recovers the original host capability", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function replayCreatedRoom");
	const end = source.indexOf("export async function readRoomSnapshot", start);
	const replaySource = source.slice(start, end);

	assert.match(replaySource, /WHERE creation_request_id = \?/);
	assert.match(replaySource, /host_participant_id/);
	assert.match(replaySource, /access_token/);
	assert.match(replaySource, /builder_invite_token/);
	assert.match(replaySource, /readRoomSnapshot/);
});

test("room snapshots read all redaction-related state from one D1 snapshot", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function readRoomSnapshot");
	const end = source.indexOf("export async function readRoomMessagesPage", start);
	const snapshotSource = source.slice(start, end);

	assert.match(snapshotSource, /await db\.batch/);
	assert.doesNotMatch(snapshotSource, /Promise\.all/);
	assert.match(snapshotSource, /const \[snapshot, messages\] = await db\.batch/);
	assert.match(snapshotSource, /json_group_array\(json_object/);
	assert.equal(snapshotSource.match(/\.prepare\(/g)?.length, 2);
	assert.match(snapshotSource, /room_runtime_redactions/);
	assert.match(snapshotSource, /SELECT COUNT\(\*\) FROM room_messages/);
	assert.match(snapshotSource, /messageCount: Number/);
});

test("room existence checks stay lightweight for public socket handshakes", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function roomExists");
	const end = source.indexOf("export async function roomMessageExists", start);
	const existenceSource = source.slice(start, end);

	assert.match(existenceSource, /SELECT 1 AS found FROM rooms WHERE id = \?/);
	assert.doesNotMatch(existenceSource, /room_messages|participants|tasks/);
});

test("message reference checks stay scoped to one room", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function roomMessageExists");
	const end = source.indexOf("export async function readRoomSnapshot", start);
	const existenceSource = source.slice(start, end);

	assert.match(
		existenceSource,
		/SELECT 1 AS found FROM room_messages WHERE id = \? AND room_id = \?/,
	);
	assert.match(existenceSource, /\.bind\(messageId, roomId\)/);
});

test("room message history uses a stable bounded cursor", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function readRoomMessagesPage");
	const end = source.indexOf("export async function addParticipant", start);
	const pageSource = source.slice(start, end);

	assert.match(pageSource, /created_at < \?/);
	assert.match(pageSource, /created_at = \? AND id < \?/);
	assert.match(pageSource, /ORDER BY created_at DESC, id DESC/);
	assert.match(pageSource, /Math\.max\(1, Math\.min\(100, limit\)\)/);
});

test("expired runtime, stale provisioning, and pending cleanup rooms are discoverable", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function listRuntimeRoomIdsNeedingCleanup");
	const end = source.indexOf("export function participantBranch", start);
	const expirySource = source.slice(start, end);

	assert.match(expirySource, /ends_at IS NOT NULL AND ends_at <= \?/);
	assert.match(expirySource, /status = 'provisioning' AND updated_at <= \?/);
	assert.match(expirySource, /status IN \('cleanup-planning', 'cleanup-ending'\)/);
	assert.match(expirySource, /'cleanup-ending'/);
	assert.match(expirySource, /LIMIT \?/);
});

test("cleanup attempts rotate eligible rooms behind newer work", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function recordRoomCleanupAttempt");
	const end = source.indexOf("export function participantBranch", start);
	const attemptSource = source.slice(start, end);

	assert.match(attemptSource, /UPDATE rooms SET updated_at = \?/);
	assert.match(attemptSource, /status IN \('cleanup-planning', 'cleanup-ending', 'provisioning'\)/);
	assert.match(attemptSource, /ends_at IS NOT NULL AND ends_at <= \?/);
	assert.match(attemptSource, /\.bind\(attemptedAt, roomId, attemptedAt\)/);
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
	assert.match(taskSource, /UPDATE rooms SET updated_at = \?/);
	assert.match(taskSource, /status IN \('setup', 'planning'\)/);
	assert.match(taskSource, /return taskResult\?\.meta\.changes === 1/);
});

test("scope-changing task updates atomically record their decision", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function updateTaskStateWithDecision");
	const end = source.indexOf("export async function addDecision", start);
	const taskSource = source.slice(start, end);

	assert.match(taskSource, /const \[decisionResult, taskResult\] = await db\.batch/);
	assert.ok(taskSource.indexOf("INSERT INTO decisions") < taskSource.indexOf("UPDATE tasks"));
	assert.match(taskSource, /EXISTS \(SELECT 1 FROM decisions WHERE id = \? AND room_id = \?\)/);
	assert.match(taskSource, /UPDATE rooms SET updated_at = \?/);
	assert.match(taskSource, /status IN \('setup', 'planning'\)/);
	assert.match(
		taskSource,
		/decisionResult\?\.meta\.changes === 1 && taskResult\?\.meta\.changes === 1/,
	);
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
	assert.match(approvalSource, /state = 'cut'/);
	assert.match(approvalSource, /started_at = NULL, ends_at = NULL/);
	assert.doesNotMatch(approvalSource, /duration_minutes \* 60000/);
});

test("plan replacement fences every write to its claimed revision", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function replacePlan");
	const end = source.indexOf("export async function approveRoomPlan", start);
	const replacementSource = source.slice(start, end);

	assert.match(replacementSource, /expectedBriefRevision/);
	assert.match(replacementSource, /nextBriefRevision/);
	assert.match(replacementSource, /AND brief_revision = \?/);
	assert.match(replacementSource, /brief_revision = \?/);
	assert.match(
		replacementSource,
		/return roomResult\?\.meta\.changes === 1 \? nextBriefRevision : null/,
	);
});

test("planning messages can bind to the exact installed revision", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function addMessage");
	const end = source.indexOf("export async function replacePlan", start);
	const messageSource = source.slice(start, end);

	assert.match(messageSource, /expectedBriefRevision/);
	assert.match(messageSource, /AND brief_revision = \?/);
	assert.match(messageSource, /UPDATE rooms SET updated_at = \?/);
	assert.match(messageSource, /status IN \('setup', 'planning'\)/);
	assert.match(
		messageSource,
		/EXISTS \(SELECT 1 FROM room_messages WHERE id = \? AND room_id = \?\)/,
	);
});

test("inactive pre-launch expiry is fenced by current activity and runtime evidence", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function expireInactivePrelaunchRooms");
	const end = source.indexOf("export async function listRuntimeRoomIdsNeedingCleanup", start);
	const expirySource = source.slice(start, end);

	assert.match(expirySource, /status IN \('setup', 'planning'\) AND updated_at <= \?/);
	assert.match(expirySource, /root_provisioning_attempted_at IS NULL/);
	assert.match(expirySource, /crabfleet_session_id IS NOT NULL/);
	assert.match(expirySource, /UPDATE rooms SET status = 'ended'/);
	assert.match(expirySource, /results\[index\]\?\.meta\.changes === 1/);
});

test("runtime leases fence cleanup and stale provisioning can be claimed", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const staleStart = source.indexOf("export async function claimStaleProvisioningCleanup");
	const cleanupEnd = source.indexOf("export async function updateParticipantRuntime", staleStart);
	const lifecycleSource = source.slice(staleStart, cleanupEnd);
	const runtimeStart = source.indexOf("export async function updateRoomRuntime");
	const runtimeEnd = source.indexOf("export async function claimRoomRuntimeLease", runtimeStart);
	const runtimeSource = source.slice(runtimeStart, runtimeEnd);

	assert.match(lifecycleSource, /status = 'provisioning' AND updated_at <= \?/);
	assert.match(lifecycleSource, /INSERT OR IGNORE INTO room_runtime_leases/);
	assert.match(lifecycleSource, /NOT EXISTS \(\s*SELECT 1 FROM room_runtime_leases/);
	assert.match(lifecycleSource, /expires_at > \?/);
	assert.match(lifecycleSource, /SELECT \?, \?, 'room_end', \?/);
	assert.match(lifecycleSource, /lease_id = \?/);
	assert.match(lifecycleSource, /renewProvisioningLease[\s\S]*brief_revision = \?/);
	assert.match(lifecycleSource, /markRootProvisioningAttempt[\s\S]*brief_revision = \?/);
	assert.match(lifecycleSource, /markRoomCleanup[\s\S]*brief_revision = \?/);
	assert.match(runtimeSource, /NOT EXISTS \(\s*SELECT 1 FROM room_runtime_leases/);
	assert.match(runtimeSource, /completeRoomProvisioning/);
	assert.match(runtimeSource, /started_at = \?, ends_at = \? \+ duration_minutes \* 60000/);
	assert.match(runtimeSource, /status = 'provisioning' AND brief_revision = \?/);
});

test("failed launch reset rotates the provisioning replay generation", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function resetRoomProvisioning");
	const end = source.indexOf("export async function recordProvisioningBinding", start);
	const resetSource = source.slice(start, end);

	assert.match(resetSource, /const nextBriefRevision = newRevision\(\)/);
	assert.match(resetSource, /brief_revision = \?/);
	assert.match(resetSource, /AND brief_revision = \?/);
	assert.match(resetSource, /root_provisioning_attempted_at = NULL/);
	assert.match(resetSource, /INSERT OR IGNORE INTO room_runtime_redactions/);
	assert.match(resetSource, /expectedStatuses/);
	assert.match(resetSource, /return roomResult\?\.meta\.changes === 1/);
	assert.ok(
		resetSource.indexOf("room_runtime_redactions") <
			resetSource.indexOf("crabfleet_root_session_id = NULL"),
	);
});

test("provisioning bindings are fenced to the approved launch generation", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function recordProvisioningBinding");
	const refreshStart = source.indexOf("export async function refreshProvisioningBinding", start);
	const end = source.indexOf("export async function claimStaleProvisioningCleanup", refreshStart);
	const bindingSource = source.slice(start, refreshStart);
	const refreshSource = source.slice(refreshStart, end);

	assert.match(bindingSource, /expectedBriefRevision/);
	assert.equal(bindingSource.match(/brief_revision = \?/g)?.length, 2);
	assert.match(bindingSource, /crabfleet_root_session_id = \?/);
	assert.match(refreshSource, /expectedBriefRevision/);
	assert.equal(refreshSource.match(/brief_revision = \?/g)?.length, 1);
	assert.match(refreshSource, /crabfleet_root_session_id = \?/);
});

test("root provisioning attempts are durable before external creation", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function markRootProvisioningAttempt");
	const end = source.indexOf("export async function markRoomCleanup", start);
	const attemptSource = source.slice(start, end);

	assert.match(attemptSource, /root_provisioning_attempted_at/);
	assert.match(attemptSource, /status = 'provisioning'/);
	assert.match(attemptSource, /brief_revision = \?/);
	assert.match(attemptSource, /roomRootProvisioningAttempted/);
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

test("conductor action delivery states transition only from requested", async () => {
	const source = await readFile(new URL("../src/store.ts", import.meta.url), "utf8");
	const start = source.indexOf("export async function updateConductorActionApprovalState");
	const end = source.indexOf("export async function claimConductorTurn", start);
	const updateSource = source.slice(start, end);

	assert.match(updateSource, /approval_state = 'requested'/);
	assert.match(updateSource, /result\.meta\.changes === 1/);
});
