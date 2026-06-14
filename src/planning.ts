import { chooseIdea, ideas, rolesForSeats } from "./catalog.ts";
import type { IdeaCard } from "./catalog.ts";
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
	const roles = rolesForSeats(active.length);
	const taskIds = active.map(() => newId("task"));
	const assignments = active.map((participant, index) => ({
		participantId: participant.id,
		roleId: roles[index]!.id,
	}));
	const tasks = active.map((participant, index) => {
		const role = roles[index]!;
		return {
			id: taskIds[index]!,
			title: role.label,
			description: role.mission,
			ownerParticipantId: participant.id,
			state: "ready" as const,
			dependsOn: index === 0 ? taskIds.slice(1) : [],
			ownsPaths: role.owns,
			acceptanceCriteria:
				index === 0
					? [
							"integrated branch runs",
							brief.demoMoment ? `demo moment: ${brief.demoMoment}` : "demo moment is visible",
						]
					: [
							brief.acceptanceCriteria?.[index % (brief.acceptanceCriteria?.length || 1)] ??
								"task works",
						],
			branch: participant.branch,
			pullRequestUrl: null,
		};
	});
	return { brief, assignments, tasks };
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
