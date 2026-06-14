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

export type ParticipantCrabboxBinding = { participantId: string; binding: CrabboxBinding };

export class PartialProvisioningError extends Error {
	readonly bindings: ParticipantCrabboxBinding[];

	constructor(cause: unknown, bindings: ParticipantCrabboxBinding[]) {
		super(cause instanceof Error ? cause.message : "room provisioning failed", { cause });
		this.name = "PartialProvisioningError";
		this.bindings = bindings;
	}
}

export function crabfleetRuntime(value: string | undefined): "container" | "crabbox" {
	return value === "container" ? "container" : "crabbox";
}

export function crabfleetOwner(value: string | undefined): string {
	return slugify(value || "multicodex", "multicodex");
}

export function crabfleetSimulationEnabled(value: string | undefined): boolean {
	return value === "true";
}

export async function provisionRoomCrabboxes(
	env: Env,
	room: Room,
	participants: Participant[],
	tasks: Task[],
): Promise<ParticipantCrabboxBinding[]> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
			return simulatedBindings(room, active);
		}
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
	const owner = crabfleetOwner(env.CRABFLEET_OWNER);
	const hostTask = tasks.find((task) => task.ownerParticipantId === host.id);
	const root = await createCrabbox(env, {
		owner,
		repo: room.repo,
		branch: host.branch || room.integrationBranch,
		baseBranch: room.baseBranch,
		purpose: hostTask?.title || "room integration",
		summary: "starting room integration",
		prompt: hostTask ? taskPrompt(room.brief, host, hostTask) : "Coordinate the room integration.",
	});
	const bindings = [{ participantId: host.id, binding: root }];
	try {
		for (const participant of active.filter((item) => item.id !== host.id)) {
			const task = tasks.find((item) => item.ownerParticipantId === participant.id);
			bindings.push({
				participantId: participant.id,
				binding: await createCrabbox(env, {
					owner,
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
			});
		}
		return await waitForUsableRoomCrabboxes(env, bindings);
	} catch (error) {
		if (error instanceof PartialProvisioningError) throw error;
		throw new PartialProvisioningError(error, bindings);
	}
}

export async function readRoomCrabboxes(
	env: Env,
	rootSessionId: string,
): Promise<CrabboxBinding[]> {
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return [];
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
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
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return;
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
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
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return;
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
	const deadline = Date.now() + 30_000;
	const known = new Map<string, CrabfleetSession | null>(sessionIds.map((id) => [id, null]));
	const stopRequested = new Set<string>();
	let terminalReads = 0;
	while (Date.now() < deadline) {
		const bindings = await readRoomCrabboxes(env, rootSessionId);
		for (const binding of bindings) known.set(binding.session.id, binding.session);
		const activeIds = [...known.entries()]
			.filter(([, session]) => !session || !terminalCrabfleetStatuses.has(session.status))
			.map(([id]) => id);
		const newStops = activeIds.filter((id) => !stopRequested.has(id));
		await Promise.all(
			newStops.map(async (sessionId) => {
				stopRequested.add(sessionId);
				const response = await crabfleetFetch(
					env,
					`/api/openclaw/crabboxes/${encodeURIComponent(sessionId)}/actions`,
					{
						method: "POST",
						body: JSON.stringify({ rootSessionId, action: "stop" }),
						headers: { "content-type": "application/json" },
					},
				);
				const binding = await responseJson<CrabboxBinding>(response);
				known.set(binding.session.id, binding.session);
			}),
		);
		const allTerminal =
			known.size > 0 &&
			[...known.values()].every(
				(session) => session && terminalCrabfleetStatuses.has(session.status),
			);
		terminalReads = allTerminal && newStops.length === 0 ? terminalReads + 1 : 0;
		if (terminalReads >= 2) return;
		await delay(250);
	}
	throw new HttpError(502, "Crabfleet cleanup did not reach a terminal state");
}

const terminalCrabfleetStatuses = new Set(["stopped", "expired", "failed"]);

async function waitForUsableRoomCrabboxes(
	env: Env,
	initial: ParticipantCrabboxBinding[],
): Promise<ParticipantCrabboxBinding[]> {
	const deadline = Date.now() + 30_000;
	let bindings = initial;
	while (Date.now() < deadline) {
		const failed = bindings.find(({ binding }) =>
			terminalCrabfleetStatuses.has(binding.session.status),
		);
		if (failed) {
			throw new PartialProvisioningError(
				new HttpError(502, `Crabfleet session ${failed.binding.session.status} before launch`),
				bindings,
			);
		}
		if (bindings.every(({ binding }) => binding.session.status === "ready")) return bindings;
		const rootSessionId =
			bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id;
		if (!rootSessionId) break;
		await delay(250);
		const refreshed = new Map(
			(await readRoomCrabboxes(env, rootSessionId)).map((binding) => [binding.session.id, binding]),
		);
		bindings = bindings.map((item) => ({
			...item,
			binding: refreshed.get(item.binding.session.id) ?? item.binding,
		}));
	}
	throw new PartialProvisioningError(
		new HttpError(502, "Crabfleet sessions did not become ready before launch"),
		bindings,
	);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function simulatedBindings(room: Room, participants: Participant[]): ParticipantCrabboxBinding[] {
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
