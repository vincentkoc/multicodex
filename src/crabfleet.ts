import type { Participant, Room, Task } from "./domain.ts";
import { HttpError, readBoundedText, slugify } from "./http.ts";
import { taskPrompt } from "./planning.ts";

export type CrabfleetSession = {
	id: string;
	rootSessionId: string | null;
	status: string;
	summary: string;
	purpose: string;
};

export type CrabboxBinding = {
	session: CrabfleetSession;
	browserUrl: string;
};

export function crabfleetRuntime(value: string | undefined): "container" | "crabbox" {
	return value === "container" ? "container" : "crabbox";
}

export async function provisionRoomCrabboxes(
	env: Env,
	room: Room,
	participants: Participant[],
	tasks: Task[],
): Promise<Array<{ participantId: string; binding: CrabboxBinding }>> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (!env.CRABFLEET_SERVICE_TOKEN) return simulatedBindings(room, active);
	const hostTask = tasks.find((task) => task.ownerParticipantId === host.id);
	const root = await createCrabbox(env, {
		owner: host.githubLogin || slugify(host.displayName, "host"),
		repo: room.repo,
		branch: host.branch || room.integrationBranch,
		baseBranch: room.baseBranch,
		purpose: hostTask?.title || "room integration",
		summary: "starting room integration",
		prompt: hostTask ? taskPrompt(room.brief, host, hostTask) : "Coordinate the room integration.",
	});
	const children = await Promise.all(
		active
			.filter((participant) => participant.id !== host.id)
			.map(async (participant) => {
				const task = tasks.find((item) => item.ownerParticipantId === participant.id);
				return {
					participantId: participant.id,
					binding: await createCrabbox(env, {
						owner: participant.githubLogin || slugify(participant.displayName, "participant"),
						repo: room.repo,
						branch: participant.branch || room.integrationBranch,
						baseBranch: room.baseBranch,
						parentSessionId: root.session.id,
						rootSessionId: root.session.id,
						purpose: task?.title || participant.roleId || "room task",
						summary: "starting assigned task",
						prompt: task
							? taskPrompt(room.brief, participant, task)
							: "Complete your assigned room task.",
					}),
				};
			}),
	);
	return [{ participantId: host.id, binding: root }, ...children];
}

export async function readRoomCrabboxes(
	env: Env,
	rootSessionId: string,
): Promise<CrabboxBinding[]> {
	if (!env.CRABFLEET_SERVICE_TOKEN) return [];
	const response = await crabfleetFetch(
		env,
		`/api/openclaw/session-roots/${encodeURIComponent(rootSessionId)}`,
	);
	const body = await responseJson<{ crabboxes?: CrabboxBinding[] }>(response);
	return body.crabboxes ?? [];
}

export async function sendCrabboxNudge(
	env: Env,
	rootSessionId: string,
	sessionId: string,
	message: string,
): Promise<void> {
	if (!env.CRABFLEET_SERVICE_TOKEN) return;
	const response = await crabfleetFetch(
		env,
		`/api/openclaw/crabboxes/${encodeURIComponent(sessionId)}/message`,
		{
			method: "POST",
			body: JSON.stringify({ rootSessionId, message, enter: true }),
			headers: { "content-type": "application/json" },
		},
	);
	await responseJson(response);
}

export async function stopRoomCrabboxes(
	env: Env,
	rootSessionId: string,
	sessionIds: string[],
): Promise<void> {
	if (!env.CRABFLEET_SERVICE_TOKEN) return;
	await Promise.all(
		sessionIds.map(async (sessionId) => {
			const response = await crabfleetFetch(
				env,
				`/api/openclaw/crabboxes/${encodeURIComponent(sessionId)}/actions`,
				{
					method: "POST",
					body: JSON.stringify({ rootSessionId, action: "stop" }),
					headers: { "content-type": "application/json" },
				},
			);
			await responseJson(response);
		}),
	);
}

async function createCrabbox(
	env: Env,
	body: {
		owner: string;
		repo: string;
		branch: string;
		baseBranch: string;
		parentSessionId?: string;
		rootSessionId?: string;
		purpose: string;
		summary: string;
		prompt: string;
	},
): Promise<CrabboxBinding> {
	const response = await crabfleetFetch(env, "/api/openclaw/crabboxes", {
		method: "POST",
		body: JSON.stringify({
			...body,
			runtime: crabfleetRuntime(env.CRABFLEET_RUNTIME),
			profile: env.CRABFLEET_PROFILE || "default",
		}),
		headers: { "content-type": "application/json" },
	});
	return responseJson<CrabboxBinding>(response);
}

async function crabfleetFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
	const response = await fetch(
		new URL(path, env.CRABFLEET_API_URL || "https://crabfleet.openclaw.ai"),
		{
			...init,
			headers: {
				authorization: `Bearer ${env.CRABFLEET_SERVICE_TOKEN}`,
				...init.headers,
			},
		},
	);
	if (!response.ok) {
		const message = await readBoundedText(response, 16 * 1024).catch(() => "");
		throw new HttpError(502, `Crabfleet ${response.status}: ${message || "request failed"}`);
	}
	return response;
}

async function responseJson<T = unknown>(response: Response): Promise<T> {
	const text = await readBoundedText(response, 256 * 1024);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new HttpError(502, "Crabfleet returned invalid JSON");
	}
}

function simulatedBindings(
	room: Room,
	participants: Participant[],
): Array<{ participantId: string; binding: CrabboxBinding }> {
	const rootId = `SIM-${room.id.slice(-8)}`;
	return participants.map((participant, index) => ({
		participantId: participant.id,
		binding: {
			session: {
				id: index === 0 ? rootId : `${rootId}-${index + 1}`,
				rootSessionId: rootId,
				status: "ready",
				summary: `Simulated ${participant.roleId || "participant"} workspace is ready`,
				purpose: participant.roleId || "room task",
			},
			browserUrl: `https://crabfleet.openclaw.ai/app/sessions/${index === 0 ? rootId : `${rootId}-${index + 1}`}`,
		},
	}));
}
