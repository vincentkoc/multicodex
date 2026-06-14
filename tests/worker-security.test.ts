import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("worker mutation routes keep terminal rooms immutable", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const messageStart = source.indexOf("const messagesMatch");
	const messageEnd = source.indexOf("const shuffleMatch", messageStart);
	const messageSource = source.slice(messageStart, messageEnd);
	const refreshStart = source.indexOf("const refreshMatch");
	const refreshEnd = source.indexOf("const nudgeMatch", refreshStart);
	const refreshSource = source.slice(refreshStart, refreshEnd);

	assert.match(messageSource, /messageStatuses/);
	assert.match(messageSource, /room messages are closed/);
	assert.match(refreshSource, /participantToken\(request\), false/);
	assert.match(refreshSource, /roomAllowsRuntimeRefresh/);
	assert.match(refreshSource, /expectedStatuses: runtimeRefreshStatuses/);
});

test("room creation and joins are recoverable", async () => {
	const [worker, client] = await Promise.all([
		readFile(new URL("../src/worker.ts", import.meta.url), "utf8"),
		readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
	]);
	const createStart = worker.indexOf('url.pathname === "/api/rooms"');
	const joinStart = worker.indexOf("const joinMatch", createStart);
	const createSource = worker.slice(createStart, joinStart);
	const joinEnd = worker.indexOf("const messagesMatch", joinStart);
	const joinSource = worker.slice(joinStart, joinEnd);

	assert.ok(
		createSource.indexOf("replayCreatedRoom") < createSource.indexOf("resolveRepoDefaultBranch"),
	);
	assert.match(createSource, /baseBranch/);
	assert.match(createSource, /requestId/);
	assert.match(joinSource, /requestId/);
	assert.match(joinSource, /maxAiSeats/);
	assert.match(joinSource, /kind !== "observer"/);
	assert.match(joinSource, /roomBuilderInviteAuthorized/);
	assert.doesNotMatch(joinSource, /await addMessage/);
	assert.match(client, /loadJoinRequestId/);
	assert.match(client, /clearJoinRequestId/);
	assert.match(client, /loadCreateRequestId/);
	assert.match(client, /clearCreateRequestId/);
	assert.match(client, /inviteToken: kind === "human"/);
	assert.match(client, /builderInviteTokenFromUrl/);
	assert.match(client, /identity\.builderInviteToken/);
});

test("participant messages fan out before asynchronous conductor work", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const messagesMatch");
	const end = source.indexOf("const shuffleMatch", start);
	const messageSource = source.slice(start, end);

	assert.ok(
		messageSource.indexOf("context.waitUntil(broadcastSnapshot") <
			messageSource.indexOf("context.waitUntil(\n\t\t\t\tconductorTurnBestEffort"),
	);
	assert.match(messageSource, /authorKind: author\.kind === "ai" \? "ai" : "human"/);
	assert.doesNotMatch(messageSource, /await conductorTurnBestEffort/);
});

test("planning announcements remain fenced against room closure", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const shuffleMatch");
	const end = source.indexOf("const approveMatch", start);
	const planningSource = source.slice(start, end);

	assert.equal(planningSource.match(/\["planning"\]/g)?.length, 2);
	assert.equal(planningSource.match(/installedRevision/g)?.length, 6);
	assert.match(planningSource, /room closed before the shuffled plan could be announced/);
	assert.match(planningSource, /room closed before the plan could be announced/);
});

test("cleanup retry preserves failed launches while end excludes unsafe lifecycle states", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const retryStart = source.indexOf("const retryCleanupMatch");
	const endStart = source.indexOf("const endMatch", retryStart);
	const retrySource = source.slice(retryStart, endStart);
	const endSource = source.slice(
		endStart,
		source.indexOf('if (url.pathname.startsWith("/api/"))', endStart),
	);

	assert.match(retrySource, /snapshot\.room\.status !== "cleanup-planning"/);
	assert.match(retrySource, /resetRoomProvisioning/);
	assert.match(retrySource, /claimStaleProvisioningCleanup/);
	assert.match(retrySource, /recoverRoomRootCrabbox/);
	assert.match(retrySource, /claimRoomRuntimeLease/);
	assert.match(retrySource, /finally \{\s*await releaseRoomRuntimeLease/);
	assert.ok(
		retrySource.indexOf("recoverRoomRootCrabbox") < retrySource.indexOf("resetRoomProvisioning"),
	);
	assert.match(retrySource, /room provisioning is still active/);
	assert.doesNotMatch(endSource, /"cleanup-planning"/);
	assert.match(endSource, /snapshot\.room\.status === "provisioning"/);
	assert.match(endSource, /active provisioning can be cancelled after its lease expires/);
	assert.doesNotMatch(
		endSource.slice(endSource.indexOf("const endableStatuses")),
		/"provisioning"/,
	);
	assert.match(endSource, /beginRoomCleanup/);
	assert.match(endSource, /const runtimeMayExist/);
	assert.ok(endSource.indexOf("recoverRoomRootCrabbox") < endSource.indexOf("await endRoom"));
	assert.match(endSource, /cleanupActionLeaseMilliseconds/);
	assert.match(endSource, /if \(await endRoom\(env\.DB, roomId\)\)/);
	assert.match(endSource, /finally \{\s*await releaseRoomRuntimeLease/);
});

test("failed launch cleanup always broadcasts its durable recovery state", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("if (error instanceof PartialProvisioningError)");
	const end = source.indexOf("const refreshMatch", start);
	const failureSource = source.slice(start, end);

	assert.match(failureSource, /try \{[\s\S]*await cleanupFailedLaunch/);
	assert.match(failureSource, /finally \{/);
	assert.match(failureSource, /error instanceof AmbiguousRootProvisioningError/);
	assert.match(failureSource, /context\.waitUntil\(broadcastSnapshot\(env, failed\)\)/);
});

test("WebSocket reconnects resync the current room snapshot", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
	const start = source.indexOf("const syncRoom");
	const end = source.indexOf("function enterRoom", start);
	const socketSource = source.slice(start, end);

	assert.match(socketSource, /socket\.onopen = syncRoom/);
	assert.match(socketSource, /if \(payload\.type === "changed"\) syncRoom\(\)/);
	assert.match(socketSource, /sequence === syncSequence/);
});

test("browser history navigation resynchronizes room state", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

	assert.match(source, /addEventListener\("popstate", synchronizeHistory\)/);
	assert.match(source, /removeEventListener\("popstate", synchronizeHistory\)/);
	assert.match(source, /const nextRoomId = roomIdFromPath\(\)/);
	assert.match(source, /setIdentity\(nextRoomId \? loadIdentity\(nextRoomId\) : null\)/);
	assert.match(source, /setSnapshot\(null\)/);
});

test("room entry persists only minimal identity with tab-scoped fallback", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
	const start = source.indexOf("function enterRoom");
	const end = source.indexOf("if (!roomId)", start);
	const enterSource = source.slice(start, end);
	const persistenceStart = source.indexOf("function minimalRoomIdentity");
	const persistenceEnd = source.indexOf("function initials", persistenceStart);
	const persistenceSource = source.slice(persistenceStart, persistenceEnd);

	assert.match(enterSource, /const identity = minimalRoomIdentity\(nextIdentity\)/);
	assert.match(enterSource, /const persisted = persistIdentity/);
	assert.match(enterSource, /roomIdFromPath\(\) === next\.room\.id/);
	assert.match(enterSource, /history\.replaceState/);
	assert.match(enterSource, /history\.pushState/);
	assert.match(enterSource, /return persisted/);
	assert.match(persistenceSource, /JSON\.stringify\(identity\)/);
	assert.match(persistenceSource, /localStorage\.setItem/);
	assert.match(persistenceSource, /sessionStorage\.setItem/);
	assert.doesNotMatch(persistenceSource, /JSON\.stringify\(nextIdentity\)/);
	assert.match(source, /if \(onEnter\(result\.snapshot, result\)\) clearCreateRequestId\(\)/);
	assert.match(source, /if \(onEnter\(result\.snapshot, result\)\) clearJoinRequestId/);
});

test("observer controls stay read-only and presentation waits for success", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");

	assert.match(source, /const readOnly = me\.kind === "observer"/);
	assert.match(source, /readOnly=\{readOnly\}/);
	assert.match(
		source,
		/canEdit=\{!readOnly && \(isHost \|\| task\.ownerParticipantId === me\.id\)\}/,
	);
	assert.match(source, /if \(await action\("present"\)\) onRecap\(\)/);
	assert.match(
		source,
		/snapshot\.room\.status === "presenting" \|\| snapshot\.room\.status === "ended"/,
	);
	assert.match(source, /setView\("recap"\)/);
	assert.match(source, /class="button ghost recap-button"/);
});

test("conductor turns are claimed before model execution and cannot nudge workspaces", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("async function conductorTurn(");
	const end = source.indexOf("async function conductorTurnBestEffort", start);
	const conductorSource = source.slice(start, end);

	assert.ok(
		conductorSource.indexOf("claimConductorTurn") < conductorSource.indexOf("runConductorTurn"),
	);
	assert.doesNotMatch(conductorSource, /tools\.nudge|nudgeParticipant/);
});

test("conductor and nudge audit state broadcast on failure paths", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const nudgeStart = source.indexOf("const nudgeMatch");
	const nudgeEnd = source.indexOf("const taskMatch", nudgeStart);
	const nudgeRoute = source.slice(nudgeStart, nudgeEnd);
	const conductorStart = source.indexOf("async function conductorTurnBestEffort");
	const conductorEnd = source.indexOf("async function cleanupFailedLaunch", conductorStart);
	const conductorSource = source.slice(conductorStart, conductorEnd);

	assert.match(nudgeRoute, /try \{[\s\S]*await nudgeParticipant/);
	assert.match(nudgeRoute, /finally \{[\s\S]*context\.waitUntil\(broadcastSnapshot/);
	assert.match(conductorSource, /finally \{[\s\S]*await broadcastSnapshot/);
});

test("only the host can cut an approved task and the cut is recorded", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const taskMatch");
	const end = source.indexOf("const presentMatch", start);
	const taskSource = source.slice(start, end);

	assert.match(taskSource, /scopeChange && actor\.id !== snapshot\.room\.hostParticipantId/);
	assert.match(taskSource, /host approval required to cut a task/);
	assert.match(taskSource, /body\.state === "cut" \|\| task\.state === "cut"/);
	assert.match(taskSource, /await updateTaskStateWithDecision/);
	assert.doesNotMatch(taskSource, /await addDecision/);
	assert.match(taskSource, /affectedTaskIds: \[task\.id\]/);
	assert.match(taskSource, /scopeChange \? scopeChangeStatuses : messageStatuses/);
	assert.doesNotMatch(taskSource, /scopeChangeStatuses[\s\S]*"provisioning"/);
});

test("plan approval revalidates the current repository allowlist", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const approveMatch");
	const end = source.indexOf("const refreshMatch", start);
	const approvalSource = source.slice(start, end);

	assert.ok(approvalSource.indexOf("repoAllowed") < approvalSource.indexOf("approveRoomPlan"));
	assert.match(approvalSource, /room repository is no longer enabled/);
	assert.match(approvalSource, /recordProvisioningBinding/);
});

test("failed launch cleanup must claim lifecycle ownership before stopping workspaces", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("async function cleanupFailedLaunch");
	const end = source.indexOf("async function nudgeParticipant", start);
	const cleanupSource = source.slice(start, end);

	assert.match(cleanupSource, /resetRoomProvisioning\(env\.DB, roomId, \["provisioning"\]\)/);
	assert.match(cleanupSource, /const claimed = await markRoomCleanup/);
	assert.match(cleanupSource, /"cleanup-planning",\s*\["provisioning"\]/);
	assert.match(cleanupSource, /if \(!claimed\) return/);
	assert.ok(
		cleanupSource.indexOf("if (!claimed) return") < cleanupSource.indexOf("stopRoomCrabboxes"),
	);
	assert.match(cleanupSource, /const cleanupLeaseId = await claimRoomRuntimeLease/);
	assert.ok(
		cleanupSource.indexOf("claimRoomRuntimeLease") < cleanupSource.indexOf("stopRoomCrabboxes"),
	);
	assert.match(cleanupSource, /finally \{\s*await releaseRoomRuntimeLease/);
	assert.doesNotMatch(cleanupSource, /\["provisioning", "building"/);
});

test("nudges reserve the runtime lifecycle before external delivery", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("async function nudgeParticipant");
	const end = source.indexOf("async function broadcastSnapshot", start);
	const nudgeSource = source.slice(start, end);

	assert.match(nudgeSource, /claimRoomRuntimeLease/);
	assert.ok(nudgeSource.indexOf("addConductorAction") < nudgeSource.indexOf("sendCrabboxNudge"));
	assert.match(nudgeSource, /approvalState: "requested"/);
	assert.match(nudgeSource, /const auditedMessage = clean\(redact\(message\), 2000\)/);
	assert.match(nudgeSource, /const auditDetail = `Instruction: \$\{auditedMessage\} Reason:/);
	assert.ok(nudgeSource.indexOf("reason: auditDetail") < nudgeSource.indexOf("sendCrabboxNudge"));
	assert.match(nudgeSource, /body: `Nudged \$\{target\.displayName\}: \$\{auditDetail\}`/);
	assert.ok(nudgeSource.indexOf("claimRoomRuntimeLease") < nudgeSource.indexOf("sendCrabboxNudge"));
	assert.match(
		nudgeSource,
		/updateConductorActionApprovalState\(\s*env\.DB,\s*roomId,\s*actionId,\s*"delivery_unknown"/,
	);
	assert.doesNotMatch(nudgeSource, /actionId, "denied"/);
	assert.match(
		nudgeSource,
		/updateConductorActionApprovalState\(env\.DB, roomId, actionId, "approved"\)/,
	);
	assert.match(nudgeSource, /finally \{\s*await releaseRoomRuntimeLease/);
});

test("runtime refresh surfaces terminal Crabfleet sessions", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const refreshMatch");
	const end = source.indexOf("const nudgeMatch", start);
	const refreshSource = source.slice(start, end);

	assert.match(refreshSource, /participantStateForCrabfleetStatus/);
});

test("local dev enables simulation without changing the production default", async () => {
	const [script, config, readme] = await Promise.all([
		readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
		readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
		readFile(new URL("../README.md", import.meta.url), "utf8"),
	]);

	assert.match(script, /MULTICODEX_SIMULATION_MODE:true/);
	assert.match(config, /"MULTICODEX_SIMULATION_MODE": "false"/);
	assert.match(readme, /enables simulation only for the local Wrangler/);
});

test("scheduled reconciliation retries cleanup and expires runtime rooms", async () => {
	const [worker, config] = await Promise.all([
		readFile(new URL("../src/worker.ts", import.meta.url), "utf8"),
		readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
	]);
	const start = worker.indexOf("async function reconcileRuntimeRooms");
	const end = worker.indexOf("function participantsWithAssignments", start);
	const expirySource = worker.slice(start, end);

	assert.match(config, /"crons": \["\*\/2 \* \* \* \*"\]/);
	assert.match(worker, /context\.waitUntil\(reconcileRuntimeRooms\(env\)\)/);
	assert.match(expirySource, /listRuntimeRoomIdsNeedingCleanup/);
	assert.match(expirySource, /provisioningStale/);
	assert.match(expirySource, /claimStaleProvisioningCleanup/);
	assert.match(expirySource, /beginRoomCleanup/);
	assert.match(expirySource, /reconcileFailedLaunchCleanup/);
	assert.match(expirySource, /recoverRoomRootCrabbox/);
	assert.match(expirySource, /stopRoomCrabboxes/);
	assert.match(expirySource, /resetRoomProvisioning/);
	assert.match(expirySource, /await endRoom/);
	assert.match(expirySource, /finally \{\s*await releaseRoomRuntimeLease/);
});

test("launch preparation renews provisioning while GitHub branches are created", async () => {
	const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = source.indexOf("const approveMatch");
	const end = source.indexOf("const refreshMatch", start);
	const launchSource = source.slice(start, end);

	assert.match(
		launchSource,
		/ensureRoomBranches\(env, snapshot\.room, snapshot\.participants, async \(\) =>/,
	);
	assert.match(launchSource, /renewProvisioningLease\(env\.DB, roomId\)/);
});

test("chat history preserves rotated live messages and recap events use chronology", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
	const chatStart = source.indexOf("function ChatPanel");
	const chatEnd = source.indexOf("function Message", chatStart);
	const chatSource = source.slice(chatStart, chatEnd);
	const recapStart = source.indexOf("function Recap");
	const recapEnd = source.indexOf("function RoomProgress", recapStart);
	const recapSource = source.slice(recapStart, recapEnd);

	assert.match(chatSource, /previousSnapshotMessages/);
	assert.match(chatSource, /rotatedMessages/);
	assert.match(chatSource, /mergeRoomMessages/);
	assert.ok(recapSource.indexOf(".sort(") < recapSource.indexOf(".slice(-5)"));
});

test("message history is paginated through the existing viewer redaction policy", async () => {
	const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
	const start = worker.indexOf("const messagesMatch");
	const end = worker.indexOf("const shuffleMatch", start);
	const messagesSource = worker.slice(start, end);

	assert.match(messagesSource, /request\.method === "GET"/);
	assert.match(messagesSource, /readRoomMessagesPage/);
	assert.match(messagesSource, /beforeId/);
	assert.match(messagesSource, /snapshotForViewer\(\{ \.\.\.snapshot, messages \}, viewer\?\.id\)/);
	assert.match(messagesSource, /messageCount: snapshot\.messageCount/);
});

test("public terminal room links render the preserved recap", async () => {
	const source = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
	const start = source.indexOf("const validIdentity");
	const end = source.indexOf("function CreateRoom", start);
	const routingSource = source.slice(start, end);

	assert.match(routingSource, /\["cleanup-planning", "cleanup-ending", "ended"\]/);
	assert.ok(routingSource.indexOf("<Recap") < routingSource.indexOf("<JoinRoom"));
});
