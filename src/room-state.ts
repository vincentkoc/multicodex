import type { RoomSnapshot, RoomStatus } from "./domain.ts";

export function roomAllowsPlanning(status: RoomStatus): boolean {
	return status === "setup" || status === "planning";
}

export function roomAllowsPresentation(status: RoomStatus): boolean {
	return status === "building" || status === "integrating";
}

export function roomAllowsRuntimeNudge(status: RoomStatus): boolean {
	return status === "building" || status === "integrating";
}

export function roomAllowsRuntimeRefresh(status: RoomStatus): boolean {
	return status === "building" || status === "integrating" || status === "presenting";
}

export function roomAllowsMessages(status: RoomStatus): boolean {
	return status !== "cleanup-planning" && status !== "cleanup-ending" && status !== "ended";
}

export function roomPlanCoversActiveParticipants(snapshot: RoomSnapshot): boolean {
	const active = snapshot.participants.filter((participant) => participant.kind !== "observer");
	const activeIds = new Set(active.map((participant) => participant.id));
	const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
	return (
		snapshot.tasks.length === active.length &&
		active.every((participant) => {
			const task = participant.taskId ? tasksById.get(participant.taskId) : undefined;
			return Boolean(participant.roleId && task && task.ownerParticipantId === participant.id);
		}) &&
		snapshot.tasks.every((task) =>
			Boolean(task.ownerParticipantId && activeIds.has(task.ownerParticipantId)),
		)
	);
}
