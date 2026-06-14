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
export type ProvisioningBindingObserver = (
	item: ParticipantCrabboxBinding,
	bindings: ParticipantCrabboxBinding[],
) => Promise<void>;

export class PartialProvisioningError extends Error {
	readonly bindings: ParticipantCrabboxBinding[];

	constructor(cause: unknown, bindings: ParticipantCrabboxBinding[]) {
		super(cause instanceof Error ? cause.message : "room provisioning failed", { cause });
		this.name = "PartialProvisioningError";
		this.bindings = bindings;
	}
}

export class AmbiguousRootProvisioningError extends HttpError {
	constructor() {
		super(502, "root Crabfleet provisioning is still reconciling");
		this.name = "AmbiguousRootProvisioningError";
	}
}

class CrabfleetRequestError extends HttpError {
	readonly upstreamStatus: number | null;

	constructor(upstreamStatus: number | null) {
		super(
			502,
			upstreamStatus ? `Crabfleet request failed (${upstreamStatus})` : "Crabfleet request failed",
		);
		this.name = "CrabfleetRequestError";
		this.upstreamStatus = upstreamStatus;
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

export function participantStateForCrabfleetStatus(
	status: string,
	current: Participant["state"],
): Participant["state"] {
	if (usableCrabfleetStatuses.has(status)) return "working";
	if (status === "failed") return "blocked";
	if (status === "stopped" || status === "expired") return "left";
	return current;
}

export async function provisionRoomCrabboxes(
	env: Env,
	room: Room,
	participants: Participant[],
	tasks: Task[],
	onBinding?: ProvisioningBindingObserver,
): Promise<ParticipantCrabboxBinding[]> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
			const bindings = simulatedBindings(room, active);
			for (const item of bindings) await onBinding?.(item, bindings);
			return bindings;
		}
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
	const owner = crabfleetOwner(env.CRABFLEET_OWNER);
	const requestId = (participantId: string) =>
		`multicodex:${room.id}:${room.briefRevision}:${participantId}`;
	const bindings: ParticipantCrabboxBinding[] = [];
	try {
		const root = await recoverRoomRootCrabbox(env, room, active, tasks);
		bindings.push(root);
		await onBinding?.(bindings[0]!, bindings);
		for (const participant of active.filter((item) => item.id !== host.id)) {
			const task = tasks.find((item) => item.ownerParticipantId === participant.id);
			const item = {
				participantId: participant.id,
				binding: await createCrabbox(env, {
					owner,
					repo: room.repo,
					branch: participant.branch || room.integrationBranch,
					baseBranch: room.baseBranch,
					requestId: requestId(participant.id),
					parentSessionId: root.binding.session.id,
					rootSessionId: root.binding.session.id,
					purpose: task?.title || participant.roleId || "room task",
					summary: "starting assigned task",
					prompt: task
						? taskPrompt(room.brief, participant, task)
						: "Complete your assigned room task.",
				}),
			};
			bindings.push(item);
			await onBinding?.(item, bindings);
		}
		const ready = await waitForUsableRoomCrabboxes(env, bindings);
		for (const item of ready) await onBinding?.(item, ready);
		return ready;
	} catch (error) {
		if (error instanceof PartialProvisioningError) throw error;
		if (!bindings.length && ambiguousCrabfleetCreate(error)) {
			throw new AmbiguousRootProvisioningError();
		}
		throw new PartialProvisioningError(error, bindings);
	}
}

export async function recoverRoomRootCrabbox(
	env: Env,
	room: Room,
	participants: Participant[],
	tasks: Task[],
): Promise<ParticipantCrabboxBinding> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
			return simulatedBindings(room, [host])[0]!;
		}
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
	const hostTask = tasks.find((task) => task.ownerParticipantId === host.id);
	return {
		participantId: host.id,
		binding: await createCrabbox(env, {
			owner: crabfleetOwner(env.CRABFLEET_OWNER),
			repo: room.repo,
			branch: host.branch || room.integrationBranch,
			baseBranch: room.baseBranch,
			requestId: `multicodex:${room.id}:${room.briefRevision}:${host.id}`,
			purpose: hostTask?.title || "room integration",
			summary: "starting room integration",
			prompt: hostTask
				? taskPrompt(room.brief, host, hostTask)
				: "Coordinate the room integration.",
		}),
	};
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
			signal: AbortSignal.timeout(20_000),
		},
	);
	await responseJson(response);
}

export async function stopRoomCrabboxes(
	env: Env,
	rootSessionId: string,
	_sessionIds: string[],
): Promise<void> {
	if (!env.CRABFLEET_SERVICE_TOKEN) {
		if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return;
		throw new HttpError(503, "Crabfleet service token is not configured");
	}
	const response = await crabfleetFetch(
		env,
		`/api/openclaw/session-roots/${encodeURIComponent(rootSessionId)}/actions`,
		{
			method: "POST",
			body: JSON.stringify({ action: "stop" }),
			headers: { "content-type": "application/json" },
			signal: AbortSignal.timeout(75_000),
		},
	);
	const result = await responseJson<{
		rootSessionId?: string;
		admissionClosed?: boolean;
		crabboxes?: CrabboxBinding[];
	}>(response);
	if (
		result.rootSessionId !== rootSessionId ||
		result.admissionClosed !== true ||
		!Array.isArray(result.crabboxes) ||
		result.crabboxes.some((binding) => !terminalCrabfleetStatuses.has(binding.session.status))
	) {
		throw new HttpError(502, "Crabfleet cleanup did not reach a terminal state");
	}
}

const terminalCrabfleetStatuses = new Set(["stopped", "expired", "failed"]);
const usableCrabfleetStatuses = new Set(["ready", "attached", "detached"]);

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
		if (bindings.every(({ binding }) => usableCrabfleetStatuses.has(binding.session.status))) {
			return bindings;
		}
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
		requestId: string;
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
	let response: Response;
	try {
		response = await fetch(
			new URL(path, env.CRABFLEET_API_URL || "https://crabfleet.openclaw.ai"),
			{
				...init,
				signal: init.signal ?? AbortSignal.timeout(20_000),
				headers: {
					authorization: `Bearer ${env.CRABFLEET_SERVICE_TOKEN}`,
					...init.headers,
				},
			},
		);
	} catch {
		throw new CrabfleetRequestError(null);
	}
	if (!response.ok) {
		console.error(JSON.stringify({ event: "crabfleet_request_failed", status: response.status }));
		throw new CrabfleetRequestError(response.status);
	}
	return response;
}

function ambiguousCrabfleetCreate(error: unknown): boolean {
	if (!(error instanceof CrabfleetRequestError)) return true;
	return (
		error.upstreamStatus === null ||
		error.upstreamStatus === 408 ||
		error.upstreamStatus === 409 ||
		error.upstreamStatus === 429 ||
		error.upstreamStatus >= 500
	);
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
