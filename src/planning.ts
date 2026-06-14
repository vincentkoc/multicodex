import { chooseIdea, rolesForSeats } from "./catalog.ts";
import type { Participant, RoomBrief, Task } from "./domain.ts";

export function shuffledBrief(seed: string, people: number): RoomBrief {
	const idea = chooseIdea(seed, people);
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
	tasks: Array<Omit<Task, "id" | "roomId" | "createdAt" | "updatedAt">>;
} {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const brief = shuffledBrief(seed, active.length);
	const roles = rolesForSeats(active.length);
	const assignments = active.map((participant, index) => ({
		participantId: participant.id,
		roleId: roles[index]!.id,
	}));
	const tasks = active.map((participant, index) => {
		const role = roles[index]!;
		return {
			title: role.label,
			description: role.mission,
			ownerParticipantId: participant.id,
			state: "ready" as const,
			dependsOn: index === 0 ? active.slice(1).map((item) => item.id) : [],
			ownsPaths: role.owns,
			acceptanceCriteria:
				index === 0
					? ["integrated branch runs", "demo moment is visible"]
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
