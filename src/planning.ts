import { chooseIdea, ideas, roles } from "./catalog.ts";
import type { IdeaCard, RoleCard } from "./catalog.ts";
import type { Participant, RoomBrief, Task } from "./domain.ts";
import { newId } from "./http.ts";

export function shuffledBrief(seed: string, people: number): RoomBrief {
	return briefForIdea(chooseIdea(seed, people));
}

function briefForIdea(idea: IdeaCard): RoomBrief {
	return {
		ideaId: idea.id,
		productGoal: idea.pitch,
		demoMoment: idea.demoMoment,
		constraints: ["ten-minute build", "one integrated preview", "no hidden conductor actions"],
		acceptanceCriteria: idea.acceptanceCriteria,
		planApproved: false,
	};
}

export function planForParticipants(
	seed: string,
	participants: Participant[],
): {
	brief: RoomBrief;
	assignments: Array<{ participantId: string; roleId: string }>;
	tasks: Array<Omit<Task, "roomId" | "createdAt" | "updatedAt">>;
} {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const selectedIdea = ideas.find(
		(idea) =>
			idea.id === seed && active.length >= idea.minPeople && active.length <= idea.maxPeople,
	);
	const brief = selectedIdea ? briefForIdea(selectedIdea) : shuffledBrief(seed, active.length);
	return planForBrief(brief, active);
}

export function planForBrief(
	brief: RoomBrief,
	participants: Participant[],
): {
	brief: RoomBrief;
	assignments: Array<{ participantId: string; roleId: string }>;
	tasks: Array<Omit<Task, "roomId" | "createdAt" | "updatedAt">>;
} {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const selectedIdea = ideas.find((idea) => idea.id === brief.ideaId);
	const effectiveBrief =
		selectedIdea &&
		(active.length < selectedIdea.minPeople || active.length > selectedIdea.maxPeople)
			? shuffledBrief(`${selectedIdea.id}:${active.length}`, active.length)
			: brief;
	const assignedRoles = rolesForParticipants(active);
	const integrationParticipant =
		active.find((participant) => participant.kind !== "ai") ?? active[0] ?? null;
	const integrationIndex = active.findIndex(
		(participant) => participant.id === integrationParticipant?.id,
	);
	const taskIds = active.map(() => newId("task"));
	const assignments = active.map((participant, index) => ({
		participantId: participant.id,
		roleId: assignedRoles[index]!.id,
	}));
	const criteriaByTask = active.map(() => [] as string[]);
	const coreCriteria = effectiveBrief.acceptanceCriteria ?? [];
	for (const [index, criterion] of coreCriteria.entries()) {
		criteriaByTask[index % Math.max(active.length, 1)]?.push(criterion);
	}
	if (coreCriteria.length) {
		for (const [index, taskCriteria] of criteriaByTask.entries()) {
			if (!taskCriteria.length) taskCriteria.push(coreCriteria[index % coreCriteria.length]!);
		}
	}
	const tasks = active.map((participant, index) => {
		const role = assignedRoles[index]!;
		const taskCriteria = criteriaByTask[index] ?? [];
		return {
			id: taskIds[index]!,
			title: role.label,
			description: role.mission,
			ownerParticipantId: participant.id,
			state: "ready" as const,
			dependsOn:
				index === integrationIndex
					? taskIds.filter((_, dependencyIndex) => dependencyIndex !== integrationIndex)
					: [],
			ownsPaths: role.owns,
			acceptanceCriteria:
				index === integrationIndex
					? [
							"integrated branch runs",
							effectiveBrief.demoMoment
								? `demo moment: ${effectiveBrief.demoMoment}`
								: "demo moment is visible",
							...taskCriteria,
						]
					: taskCriteria.length
						? taskCriteria
						: ["task works"],
			branch: participant.branch,
			pullRequestUrl: null,
		};
	});
	return { brief: effectiveBrief, assignments, tasks };
}

function rolesForParticipants(participants: Participant[]): RoleCard[] {
	const assignments = new Map<string, RoleCard>();
	const available = [...roles];
	const integrationParticipant =
		participants.find((participant) => participant.kind !== "ai") ?? participants[0];
	const integrationRole = roles.find((role) => role.id === "product-integration")!;
	if (integrationParticipant && integrationParticipant.kind !== "ai") {
		assignments.set(integrationParticipant.id, integrationRole);
		available.splice(available.indexOf(integrationRole), 1);
	}
	for (const participant of participants) {
		if (assignments.has(participant.id)) continue;
		const index = available.findIndex(
			(role) => participant.kind !== "ai" || role.suitableForAISeat,
		);
		if (index < 0) throw new RangeError("not enough unique suitable roles for this team");
		const role = available.splice(index, 1)[0]!;
		assignments.set(participant.id, role);
	}
	return participants.map((participant) => assignments.get(participant.id)!);
}

export function taskPrompt(
	brief: RoomBrief,
	participant: Participant,
	task: Pick<Task, "title" | "description" | "ownsPaths" | "acceptanceCriteria">,
): string {
	return [
		"You are one lane in a MultiCodex hackathon room.",
		`Product goal: ${brief.productGoal ?? "Build the approved room idea."}`,
		`Your role: ${participant.roleId ?? task.title}`,
		`Your task: ${task.description}`,
		`Own only: ${task.ownsPaths.join(", ") || "your assigned task"}`,
		`Acceptance: ${task.acceptanceCriteria.join("; ")}`,
		"Commit and push your branch as you make meaningful progress.",
		"Keep your Crabfleet summary current. Do not change unrelated work.",
	].join("\n");
}
