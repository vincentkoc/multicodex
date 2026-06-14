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

	assert.match(cleanupSource, /const claimed = await markRoomCleanup/);
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
