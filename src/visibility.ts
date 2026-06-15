import type { RoomSnapshot } from "./domain.ts";
import { redactRuntimeValue, runtimeRedactor } from "./runtime-redaction.ts";

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
	const sanitized = redactRuntimeValue(
		{
			...snapshot,
			room: { ...snapshot.room, crabfleetRootSessionId: null },
			participants: snapshot.participants.map((participant) => ({
				...participant,
				crabfleetSessionId: null,
				browserUrl: null,
				runtimeSummary: viewerId ? participant.runtimeSummary : "",
			})),
			conductorActions: snapshot.conductorActions.map((action) => ({
				...action,
				targetIds: action.targetIds.filter((id) => publicIds.has(id)),
				evidenceRefs: action.evidenceRefs.filter((id) => publicIds.has(id)),
			})),
			runtimeRedactions: [],
		},
		runtimeRedactor(snapshot),
	) as RoomSnapshot;
	if (viewerId) {
		const source = snapshot.participants.find((participant) => participant.id === viewerId);
		const viewer = sanitized.participants.find((participant) => participant.id === viewerId);
		if (source && viewer) viewer.browserUrl = source.browserUrl;
	}
	return sanitized;
}
