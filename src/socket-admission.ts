export const maxRoomWebSockets = 64;
export const maxPublicRoomWebSockets = 16;
export const maxPublicRoomWebSocketsPerSource = 4;
export const maxObserverRoomWebSockets = 16;
export const maxParticipantWebSockets = 4;
export const publicRoomWebSocketTag = "public";
export const observerRoomWebSocketTag = "observer";
export const builderRoomWebSocketTag = "builder";
export const roomWebSocketTicketHeader = "x-multicodex-socket-ticket";

const socketMessageWindowMilliseconds = 10_000;
const maxSocketMessagesPerWindow = 30;

export interface SocketRateState {
	windowStartedAt: number;
	messageCount: number;
}

export function sameOriginWebSocketRequest(request: Request): boolean {
	const origin = request.headers.get("origin");
	return origin !== null && origin === new URL(request.url).origin;
}

export function participantRoomWebSocketTag(participantId: string): string {
	return `participant:${participantId}`;
}

export function publicRoomWebSocketSourceTag(sourceKey: string | null): string | null {
	return sourceKey && /^[a-f0-9]{64}$/.test(sourceKey) ? `public-source:${sourceKey}` : null;
}

export function recordSocketMessage(
	previous: SocketRateState | null,
	now: number,
): { allowed: boolean; state: SocketRateState } {
	const state =
		previous && now - previous.windowStartedAt < socketMessageWindowMilliseconds
			? { ...previous, messageCount: previous.messageCount + 1 }
			: { windowStartedAt: now, messageCount: 1 };
	return { allowed: state.messageCount <= maxSocketMessagesPerWindow, state };
}
