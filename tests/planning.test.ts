import assert from "node:assert/strict";
import test from "node:test";

import { roles } from "../src/catalog.ts";
import type { Participant, RoomBrief } from "../src/domain.ts";
import { planForBrief, planForParticipants, taskPrompt } from "../src/planning.ts";

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
	const taskIds = new Set(plan.tasks.map((task) => task.id));
	assert.ok(plan.tasks.flatMap((task) => task.dependsOn).every((id) => taskIds.has(id)));
	assert.ok(
		plan.brief.acceptanceCriteria?.every((criterion) =>
			plan.tasks.some((task) => task.acceptanceCriteria.includes(criterion)),
		),
	);
});

test("planning gives AI seats only suitable roles and keeps human integration ownership", () => {
	const reordered = [participants[2]!, participants[0]!, participants[1]!];
	const plan = planForParticipants("room", reordered);
	const roleByParticipant = new Map(
		plan.assignments.map((assignment) => [assignment.participantId, assignment.roleId]),
	);
	const aiRole = roles.find((role) => role.id === roleByParticipant.get("p3"));

	assert.equal(aiRole?.suitableForAISeat, true);
	assert.equal(roleByParticipant.get("p1"), "product-integration");
});

test("task prompts keep the participant scope explicit", () => {
	const plan = planForParticipants("room", participants);
	const prompt = taskPrompt(plan.brief, participants[1]!, plan.tasks[1]!);
	assert.match(prompt, /Own only:/);
	assert.match(prompt, /Commit and push/);
	assert.match(prompt, /Do not change unrelated work/);
});

test("planning by selected idea id keeps that idea and its task criteria", () => {
	const plan = planForParticipants("latency-race", participants);
	assert.equal(plan.brief.ideaId, "latency-race");
	assert.match(plan.brief.productGoal ?? "", /public APIs/);
	assert.match(plan.tasks[0]?.acceptanceCriteria.join(" ") ?? "", /leaderboard animates/);
	assert.ok(
		plan.tasks
			.slice(1)
			.every((task) =>
				task.acceptanceCriteria.every((criterion) =>
					plan.brief.acceptanceCriteria?.includes(criterion),
				),
			),
	);
});

test("planning replaces an explicitly selected idea when the team size is incompatible", () => {
	const plan = planForParticipants("latency-race", participants.slice(0, 1));
	assert.notEqual(plan.brief.ideaId, "latency-race");
	assert.equal(plan.brief.ideaId, "solo-demo-switchboard");
});

test("planning from a stored brief preserves it and derives tasks from it", () => {
	const brief: RoomBrief = {
		ideaId: "stored-idea",
		productGoal: "Build the selected stored idea.",
		demoMoment: "The selected idea wins the demo.",
		constraints: ["keep the selected idea"],
		acceptanceCriteria: ["selected criterion one", "selected criterion two"],
		planApproved: false,
	};
	const plan = planForBrief(brief, participants);
	assert.equal(plan.brief, brief);
	assert.match(plan.tasks[0]?.acceptanceCriteria.join(" ") ?? "", /selected idea wins/);
	assert.ok(
		plan.tasks
			.slice(1)
			.every((task) =>
				task.acceptanceCriteria.every((criterion) => brief.acceptanceCriteria?.includes(criterion)),
			),
	);
	assert.ok(
		brief.acceptanceCriteria?.every((criterion) =>
			plan.tasks.some((task) => task.acceptanceCriteria.includes(criterion)),
		),
	);
});
