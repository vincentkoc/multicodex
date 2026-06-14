import type { RoomSnapshot } from "./domain.ts";

export function snapshotForViewer(
	snapshot: RoomSnapshot,
	viewerId: string | null = null,
): RoomSnapshot {
	const publicIds = new Set([
		...snapshot.participants.map((participant) => participant.id),
		...snapshot.tasks.map((task) => task.id),
		...snapshot.messages.map((message) => message.id),
		...snapshot.decisions.map((decision) => decision.id),
	]);
	return {
		...snapshot,
		room: { ...snapshot.room, crabfleetRootSessionId: null },
		participants: snapshot.participants.map((participant) => ({
			...participant,
			crabfleetSessionId: null,
			browserUrl: participant.id === viewerId ? participant.browserUrl : null,
		})),
		conductorActions: snapshot.conductorActions.map((action) => ({
			...action,
			targetIds: action.targetIds.filter((id) => publicIds.has(id)),
			evidenceRefs: action.evidenceRefs.filter((id) => publicIds.has(id)),
		})),
	};
}
