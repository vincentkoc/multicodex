export const maxRoomWebSockets = 64;

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
