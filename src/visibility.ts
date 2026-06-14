import type { RoomSnapshot } from "./domain.ts";

export function snapshotForViewer(
	snapshot: RoomSnapshot,
	viewerId: string | null = null,
): RoomSnapshot {
	return {
		...snapshot,
		room: { ...snapshot.room, crabfleetRootSessionId: null },
		participants: snapshot.participants.map((participant) => ({
			...participant,
			crabfleetSessionId: null,
			browserUrl: participant.id === viewerId ? participant.browserUrl : null,
		})),
	};
}
