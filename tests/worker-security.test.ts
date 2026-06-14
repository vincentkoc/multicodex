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

test("cleanup retry preserves failed launches while end excludes cleanup-planning", async () => {
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
	assert.doesNotMatch(endSource, /"cleanup-planning"/);
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

	assert.match(
		taskSource,
		/body\.state === "cut" && actor\.id !== snapshot\.room\.hostParticipantId/,
	);
	assert.match(taskSource, /host approval required to cut a task/);
	assert.match(taskSource, /await addDecision/);
	assert.match(taskSource, /affectedTaskIds: \[task\.id\]/);
});
