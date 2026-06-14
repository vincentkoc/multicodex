import assert from "node:assert/strict";
import test from "node:test";

import type { Participant } from "../src/domain.ts";
import { planForParticipants, taskPrompt } from "../src/planning.ts";

const participants: Participant[] = ["Vincent", "Queenie", "AI QA"].map((displayName, index) => ({
	id: `p${index + 1}`,
	roomId: "room",
	kind: index === 2 ? "ai" : "human",
	displayName,
	githubLogin: null,
	roleId: null,
	taskId: null,
	crabfleetSessionId: null,
	browserUrl: null,
	runtimeSummary: "",
	branch: `multicodex/room/p${index + 1}`,
	state: "joined",
	joinedAt: 1,
	createdAt: 1,
	updatedAt: 1,
}));

test("planning assigns one bounded task and distinct role per active participant", () => {
	const plan = planForParticipants("room", participants);
	assert.equal(plan.assignments.length, 3);
	assert.equal(plan.tasks.length, 3);
	assert.equal(new Set(plan.assignments.map((assignment) => assignment.roleId)).size, 3);
	assert.ok(plan.tasks.every((task) => task.acceptanceCriteria.length > 0));
});

test("task prompts keep the participant scope explicit", () => {
	const plan = planForParticipants("room", participants);
	const prompt = taskPrompt(plan.brief, participants[1]!, plan.tasks[1]!);
	assert.match(prompt, /Own only:/);
	assert.match(prompt, /Commit and push/);
	assert.match(prompt, /Do not change unrelated work/);
});
