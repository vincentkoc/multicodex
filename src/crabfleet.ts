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

type CrabboxCreateRequest = {
	owner: string;
	repo: string;
	branch: string;
	baseBranch: string;
	requestId: string;
	runtime: "container" | "crabbox";
	profile: string;
	parentSessionId?: string;
	rootSessionId?: string;
	purpose: string;
	summary: string;
	prompt: string;
};

export type RootCrabboxRequest = {
	participantId: string;
	body: Omit<CrabboxCreateRequest, "parentSessionId" | "rootSessionId">;
};

export type ParticipantCrabboxBinding = { participantId: string; binding: CrabboxBinding };
export type ProvisioningBindingObserver = (
	item: ParticipantCrabboxBinding,
	bindings: ParticipantCrabboxBinding[],
	stage: "created" | "ready",
) => Promise<void>;

export const readinessPollDelays = [1_000, 2_000, 4_000, 8_000, 12_000] as const;

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
	rootRequest?: RootCrabboxRequest,
): Promise<ParticipantCrabboxBinding[]> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
		const bindings = simulatedBindings(room, active);
		for (const item of bindings) await onBinding?.(item, bindings, "created");
		return bindings;
	}
	if (!env.CRABFLEET_SERVICE_TOKEN)
		throw new HttpError(503, "Crabfleet service token is not configured");
	const owner = crabfleetOwner(env.CRABFLEET_OWNER);
	const requestId = (participantId: string) =>
		`multicodex:${room.id}:${room.briefRevision}:${participantId}`;
	const bindings: ParticipantCrabboxBinding[] = [];
	try {
		const root = await recoverRoomRootCrabbox(env, room, active, tasks, rootRequest);
		bindings.push(root);
		await onBinding?.(bindings[0]!, bindings, "created");
		for (const participant of active.filter((item) => item.id !== host.id)) {
			const task = tasks.find((item) => item.ownerParticipantId === participant.id);
			const item = {
				participantId: participant.id,
				binding: await createCrabbox(
					env,
					crabboxCreateRequest(env, {
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
				),
			};
			bindings.push(item);
			await onBinding?.(item, bindings, "created");
		}
		const ready = await waitForUsableRoomCrabboxes(env, bindings);
		for (const item of ready) await onBinding?.(item, ready, "ready");
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
	rootRequest?: RootCrabboxRequest,
): Promise<ParticipantCrabboxBinding> {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
		return simulatedBindings(room, [host])[0]!;
	}
	if (!env.CRABFLEET_SERVICE_TOKEN)
		throw new HttpError(503, "Crabfleet service token is not configured");
	const request = rootRequest ?? roomRootCrabboxRequest(env, room, participants, tasks);
	if (request.participantId !== host.id) {
		throw new HttpError(409, "persisted root Crabfleet request does not match the room host");
	}
	return {
		participantId: request.participantId,
		binding: await createCrabbox(env, request.body),
	};
}

export function roomRootCrabboxRequest(
	env: Env,
	room: Room,
	participants: Participant[],
	tasks: Task[],
): RootCrabboxRequest {
	const active = participants.filter((participant) => participant.kind !== "observer");
	const host = active.find((participant) => participant.id === room.hostParticipantId) ?? active[0];
	if (!host) throw new HttpError(400, "room has no active participant");
	const hostTask = tasks.find((task) => task.ownerParticipantId === host.id);
	return {
		participantId: host.id,
		body: crabboxCreateRequest(env, {
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

export function parseRootCrabboxRequest(value: string): RootCrabboxRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new HttpError(409, "persisted root Crabfleet request is invalid");
	}
	if (!isRecord(parsed) || !isRecord(parsed.body)) {
		throw new HttpError(409, "persisted root Crabfleet request is invalid");
	}
	const participantId = nonEmptyString(parsed.participantId);
	const body = parsed.body;
	const runtime = body.runtime === "container" || body.runtime === "crabbox" ? body.runtime : null;
	const request = {
		owner: nonEmptyString(body.owner),
		repo: nonEmptyString(body.repo),
		branch: nonEmptyString(body.branch),
		baseBranch: nonEmptyString(body.baseBranch),
		requestId: nonEmptyString(body.requestId),
		runtime,
		profile: nonEmptyString(body.profile),
		purpose: nonEmptyString(body.purpose),
		summary: nonEmptyString(body.summary),
		prompt: nonEmptyString(body.prompt),
	};
	if (!participantId || Object.values(request).some((item) => item === null)) {
		throw new HttpError(409, "persisted root Crabfleet request is invalid");
	}
	return {
		participantId,
		body: request as RootCrabboxRequest["body"],
	};
}

export async function readRoomCrabboxes(
	env: Env,
	rootSessionId: string,
): Promise<CrabboxBinding[]> {
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return [];
	if (!env.CRABFLEET_SERVICE_TOKEN)
		throw new HttpError(503, "Crabfleet service token is not configured");
	const response = await crabfleetFetch(
		env,
		`/api/openclaw/session-roots/${encodeURIComponent(rootSessionId)}`,
	);
	const body = await responseJson<unknown>(response);
	if (!isRecord(body) || !Array.isArray(body.crabboxes)) {
		throw new HttpError(502, "Crabfleet returned an invalid session tree");
	}
	return body.crabboxes.map((binding) => validatedCrabboxBinding(binding, rootSessionId));
}

export async function sendCrabboxNudge(
	env: Env,
	rootSessionId: string,
	sessionId: string,
	message: string,
): Promise<void> {
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return;
	if (!env.CRABFLEET_SERVICE_TOKEN)
		throw new HttpError(503, "Crabfleet service token is not configured");
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
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) return;
	if (!env.CRABFLEET_SERVICE_TOKEN)
		throw new HttpError(503, "Crabfleet service token is not configured");
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
	const result = await responseJson<unknown>(response);
	if (!isRecord(result) || !Array.isArray(result.crabboxes)) {
		throw new HttpError(502, "Crabfleet cleanup did not reach a terminal state");
	}
	const crabboxes = result.crabboxes.map((binding) =>
		validatedCrabboxBinding(binding, rootSessionId),
	);
	const terminalSessionIds = new Set(
		crabboxes
			.filter((binding) => terminalCrabfleetStatuses.has(binding.session.status))
			.map((binding) => binding.session.id),
	);
	if (
		result.rootSessionId !== rootSessionId ||
		result.admissionClosed !== true ||
		!terminalSessionIds.has(rootSessionId) ||
		crabboxes.some((binding) => !terminalCrabfleetStatuses.has(binding.session.status))
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
	for (const pollDelay of readinessPollDelays) {
		const ready = usableRoomCrabboxes(bindings);
		if (ready) return ready;
		const rootSessionId =
			bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id;
		if (!rootSessionId) break;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		// Keep launch comfortably below the Workers free-tier subrequest cap.
		await delay(Math.min(pollDelay, remaining));
		const refreshed = new Map(
			(await readRoomCrabboxes(env, rootSessionId)).map((binding) => [binding.session.id, binding]),
		);
		bindings = bindings.map((item) => ({
			...item,
			binding: refreshed.get(item.binding.session.id) ?? item.binding,
		}));
	}
	const ready = usableRoomCrabboxes(bindings);
	if (ready) return ready;
	throw new PartialProvisioningError(
		new HttpError(502, "Crabfleet sessions did not become ready before launch"),
		bindings,
	);
}

function usableRoomCrabboxes(
	bindings: ParticipantCrabboxBinding[],
): ParticipantCrabboxBinding[] | null {
	const failed = bindings.find(({ binding }) =>
		terminalCrabfleetStatuses.has(binding.session.status),
	);
	if (failed) {
		throw new PartialProvisioningError(
			new HttpError(502, `Crabfleet session ${failed.binding.session.status} before launch`),
			bindings,
		);
	}
	return bindings.every(({ binding }) => usableCrabfleetStatuses.has(binding.session.status))
		? bindings
		: null;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createCrabbox(env: Env, body: CrabboxCreateRequest): Promise<CrabboxBinding> {
	const response = await crabfleetFetch(env, "/api/openclaw/crabboxes", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
	return validatedCrabboxBinding(
		await responseJson<unknown>(response),
		body.rootSessionId,
		!body.parentSessionId,
	);
}

function crabboxCreateRequest(
	env: Env,
	body: Omit<CrabboxCreateRequest, "runtime" | "profile">,
): CrabboxCreateRequest {
	return {
		...body,
		runtime: crabfleetRuntime(env.CRABFLEET_RUNTIME),
		profile: env.CRABFLEET_PROFILE || "default",
	};
}

async function crabfleetFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
	if (crabfleetSimulationEnabled(env.MULTICODEX_SIMULATION_MODE)) {
		throw new HttpError(500, "real Crabfleet requests are disabled in simulation");
	}
	let response: Response;
	try {
		response = await fetch(crabfleetUrl(env, path), {
			...init,
			signal: init.signal ?? AbortSignal.timeout(20_000),
			headers: {
				authorization: `Bearer ${env.CRABFLEET_SERVICE_TOKEN}`,
				...init.headers,
			},
		});
	} catch {
		throw new CrabfleetRequestError(null);
	}
	if (!response.ok) {
		console.error(JSON.stringify({ event: "crabfleet_request_failed", status: response.status }));
		throw new CrabfleetRequestError(response.status);
	}
	return response;
}

function crabfleetUrl(env: Env, path: string): URL {
	const url = new URL(env.CRABFLEET_API_URL || "https://crabfleet.openclaw.ai");
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
	url.search = "";
	url.hash = "";
	return url;
}

function ambiguousCrabfleetCreate(error: unknown): boolean {
	if (!(error instanceof CrabfleetRequestError)) return true;
	return (
		error.upstreamStatus === null ||
		error.upstreamStatus === 408 ||
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

function validatedCrabboxBinding(
	value: unknown,
	expectedRootSessionId?: string,
	allowRootBinding = true,
): CrabboxBinding {
	if (!isRecord(value) || !isRecord(value.session)) {
		throw new HttpError(502, "Crabfleet returned an invalid workspace binding");
	}
	const session = value.session;
	if (!("rootSessionId" in session)) {
		throw new HttpError(502, "Crabfleet returned an invalid workspace binding");
	}
	const id = nonEmptyString(session.id);
	const rootSessionId =
		session.rootSessionId === null ? null : nonEmptyString(session.rootSessionId);
	const status = nonEmptyString(session.status);
	const summary = nonEmptyString(session.summary);
	const purpose = nonEmptyString(session.purpose);
	const browserUrl = nonEmptyString(value.browserUrl);
	if (!id || !status || !summary || !purpose || !browserUrl || !validBrowserUrl(browserUrl)) {
		throw new HttpError(502, "Crabfleet returned an invalid workspace binding");
	}
	if (
		(expectedRootSessionId &&
			id !== expectedRootSessionId &&
			rootSessionId !== expectedRootSessionId) ||
		(expectedRootSessionId && !allowRootBinding && id === expectedRootSessionId) ||
		(!expectedRootSessionId && rootSessionId !== null && rootSessionId !== id)
	) {
		throw new HttpError(502, "Crabfleet returned a workspace outside the expected session tree");
	}
	return {
		session: { id, rootSessionId, status, summary, purpose },
		browserUrl,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function validBrowserUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
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
