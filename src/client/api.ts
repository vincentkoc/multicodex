import type { RoomSnapshot, TaskState } from "../domain.ts";

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
};

type RequestOptions = {
	method?: "GET" | "POST";
	body?: unknown;
	participantToken?: string | null;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const response = await fetch(path, {
		method: options.method ?? "GET",
		headers: {
			...(options.body ? { "content-type": "application/json" } : {}),
			...(options.participantToken ? { authorization: `Bearer ${options.participantToken}` } : {}),
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const payload = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new Error(payload.error || `request failed (${response.status})`);
	return payload as T;
}

export function createRoom(input: {
	title: string;
	hostName: string;
	repo: string;
	durationMinutes: number;
}): Promise<{ snapshot: RoomSnapshot } & RoomIdentity> {
	return request("/api/rooms", { method: "POST", body: input });
}

export function readRoom(roomId: string, participantToken?: string | null): Promise<RoomSnapshot> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}`, { participantToken });
}

export function joinRoom(
	roomId: string,
	input: { displayName: string; githubLogin: string; kind: "human" | "observer" },
): Promise<{ snapshot: RoomSnapshot } & RoomIdentity> {
	return request(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: "POST", body: input });
}

export function catalog(): Promise<Catalog> {
	return request("/api/catalog");
}

export function roomAction(
	roomId: string,
	participantToken: string,
	action: "shuffle" | "plan" | "approve-plan" | "refresh" | "present" | "end",
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

export function roomSocketUrl(roomId: string): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`;
}
