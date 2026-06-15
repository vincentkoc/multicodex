import type { RoomMessage, RoomSnapshot, TaskState } from "../domain.ts";

export type Catalog = {
	ideas: Array<{
		id: string;
		title: string;
		pitch: string;
		demoMoment: string;
	}>;
	roles: Array<{
		id: string;
		label: string;
		mission: string;
		color: string;
	}>;
};

export type RoomIdentity = {
	participantId: string;
	participantToken: string;
	builderInviteToken?: string | null;
};

type RequestOptions = {
	method?: "GET" | "POST";
	body?: unknown;
	eventCode?: string;
	participantToken?: string | null;
};

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const response = await fetch(path, {
		method: options.method ?? "GET",
		headers: {
			...(options.body ? { "content-type": "application/json" } : {}),
			...(options.eventCode ? { "x-multicodex-event-code": options.eventCode } : {}),
			...(options.participantToken ? { authorization: `Bearer ${options.participantToken}` } : {}),
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const payload = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) {
		throw new ApiError(response.status, payload.error || `request failed (${response.status})`);
	}
	return payload as T;
}

export function createRoom(input: {
	title: string;
	hostName: string;
	repo: string;
	durationMinutes: number;
	eventCode: string;
	requestId: string;
}): Promise<{ snapshot: RoomSnapshot } & RoomIdentity> {
	const { eventCode, ...body } = input;
	return request("/api/rooms", { method: "POST", body, eventCode });
}

export function readRoom(roomId: string, participantToken?: string | null): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}`, { participantToken });
}

export function readMessagesPage(
	roomId: string,
	before: { createdAt: number; id: string },
	participantToken?: string | null,
): Promise<{ messages: RoomMessage[]; messageCount: number }> {
	const query = new URLSearchParams({
		before: String(before.createdAt),
		beforeId: before.id,
		limit: "100",
	});
	return request(`/api/rooms/${encodeURIComponent(roomId)}/messages?${query}`, {
		participantToken,
	});
}

export function joinRoom(
	roomId: string,
	input: {
		displayName: string;
		githubLogin: string;
		kind: "human" | "ai" | "observer";
		requestId: string;
		inviteToken?: string;
	},
): Promise<{ snapshot: RoomSnapshot } & RoomIdentity> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: "POST", body: input });
}

export function issueRoomSocketTicket(roomId: string, participantToken: string): Promise<string> {
	return request<{ ticket: string }>(`/api/rooms/${encodeURIComponent(roomId)}/socket-ticket`, {
		method: "POST",
		participantToken,
	}).then((result) => result.ticket);
}

export function issuePublicRoomSocketTicket(
	roomId: string,
	browserSourceId: string,
): Promise<string> {
	return request<{ ticket: string }>(
		`/api/rooms/${encodeURIComponent(roomId)}/public-socket-ticket`,
		{
			method: "POST",
			body: { browserSourceId },
		},
	).then((result) => result.ticket);
}

export function catalog(): Promise<Catalog> {
	return request("/api/catalog");
}

export function roomAction(
	roomId: string,
	participantToken: string,
	action: "shuffle" | "plan" | "approve-plan" | "refresh" | "retry-cleanup" | "present" | "end",
): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/${action}`, {
		method: "POST",
		participantToken,
	});
}

export function postMessage(
	roomId: string,
	participantToken: string,
	input: {
		body: string;
		targetKind: "room" | "conductor" | "participant";
		targetId?: string | null;
	},
): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
		method: "POST",
		participantToken,
		body: input,
	});
}

export function nudgeParticipant(
	roomId: string,
	participantToken: string,
	input: { participantId: string; message: string; reason: string },
): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/nudge`, {
		method: "POST",
		participantToken,
		body: input,
	});
}

export function setTaskState(
	roomId: string,
	participantToken: string,
	taskId: string,
	state: TaskState,
): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}`, {
		method: "POST",
		participantToken,
		body: { state },
	});
}

export function roomSocketUrl(roomId: string, ticket?: string | null): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`);
	if (ticket) url.searchParams.set("ticket", ticket);
	return url.toString();
}
