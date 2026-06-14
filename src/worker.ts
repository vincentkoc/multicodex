import { ideas, roles } from "./catalog.ts";
import { activeRoomLimit, eventAccessAuthorized } from "./access.ts";
import { conductorCanNudge, runConductorTurn } from "./conductor.ts";
import {
	provisionRoomCrabboxes,
	readRoomCrabboxes,
	sendCrabboxNudge,
	stopRoomCrabboxes,
} from "./crabfleet.ts";
import type { MessageTargetKind, Participant, RoomSnapshot, TaskState } from "./domain.ts";
import { ensureRoomBranches } from "./github.ts";
import {
	clean,
	HttpError,
	json,
	optionalParticipantToken,
	participantToken,
	readJson,
} from "./http.ts";
import { planForParticipants, shuffledBrief } from "./planning.ts";
import { repoAllowed } from "./repos.ts";
import {
	roomAllowsPlanning,
	roomAllowsPresentation,
	roomAllowsRuntimeNudge,
} from "./room-state.ts";
import { RoomHub } from "./room-hub.ts";
import {
	addConductorAction,
	addDecision,
	addMessage,
	addParticipant,
	approveRoomPlan,
	clearRoomPlan,
	countActiveRooms,
	createRoom,
	endRoom,
	readRoomSnapshot,
	replacePlan,
	requireRoomParticipant,
	resetRoomProvisioning,
	setParticipantRoles,
	updateParticipantRuntime,
	updateRoomBrief,
	updateRoomRuntime,
	updateTaskState,
} from "./store.ts";
import { snapshotForViewer } from "./visibility.ts";

export { RoomHub };

export default {
	async fetch(request, env, context): Promise<Response> {
		try {
			return await route(request, env, context);
		} catch (error) {
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : "request failed";
			console.error(
				JSON.stringify({
					event: "request_error",
					status,
					message,
					path: new URL(request.url).pathname,
				}),
			);
			return json({ error: message }, status);
		}
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
	if (request.method === "GET" && url.pathname === "/api/catalog") return json({ ideas, roles });

	if (request.method === "POST" && url.pathname === "/api/rooms") {
		if (
			!eventAccessAuthorized(request.headers.get("x-multicodex-event-code"), env.EVENT_ACCESS_CODE)
		) {
			throw new HttpError(401, "valid event code required");
		}
		if (
			(await countActiveRooms(env.DB, Date.now() - 6 * 60 * 60 * 1000)) >=
			activeRoomLimit(env.MAX_ACTIVE_ROOMS)
		) {
			throw new HttpError(429, "active room limit reached");
		}
		const body = await readJson<{
			title?: string;
			hostName?: string;
			repo?: string;
			durationMinutes?: number;
		}>(request);
		const title = clean(body.title, 100) || "OpenAI event room";
		const hostName = clean(body.hostName, 80) || "Host";
		const durationMinutes = Math.max(5, Math.min(240, Math.floor(body.durationMinutes ?? 30)));
		const repo = clean(body.repo, 160) || env.DEFAULT_REPO || "vincentkoc/multicodex";
		if (!repoAllowed(repo, env.ALLOWED_REPOS, env.DEFAULT_REPO)) {
			throw new HttpError(400, "repo is not enabled for this MultiCodex deployment");
		}
		const created = await createRoom(env.DB, {
			title,
			hostName,
			repo,
			durationMinutes,
		});
		context.waitUntil(broadcastSnapshot(env, created.snapshot));
		return json(
			{
				snapshot: snapshotForViewer(created.snapshot, created.snapshot.room.hostParticipantId),
				participantId: created.snapshot.room.hostParticipantId,
				participantToken: created.participantToken,
			},
			201,
		);
	}

	const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
	if (request.method === "GET" && roomMatch) {
		const roomId = decodeURIComponent(roomMatch[1] ?? "");
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		const token = optionalParticipantToken(request);
		const viewer = token ? await requireRoomParticipant(env.DB, roomId, token) : null;
		return json(snapshotForViewer(snapshot, viewer?.id));
	}

	const roomWsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
	if (request.method === "GET" && roomWsMatch) {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			throw new HttpError(426, "websocket upgrade required");
		}
		const roomId = decodeURIComponent(roomWsMatch[1] ?? "");
		await readRoomSnapshot(env.DB, roomId);
		return env.ROOM_HUB.getByName(roomId).fetch(request);
	}

	const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
	if (request.method === "POST" && joinMatch) {
		const roomId = decodeURIComponent(joinMatch[1] ?? "");
		const body = await readJson<{
			displayName?: string;
			githubLogin?: string;
			kind?: "human" | "ai" | "observer";
		}>(request);
		const displayName = clean(body.displayName, 80);
		if (!displayName) throw new HttpError(400, "display name is required");
		const joined = await addParticipant(env.DB, roomId, {
			displayName,
			githubLogin: clean(body.githubLogin, 80) || null,
			kind: body.kind === "observer" || body.kind === "ai" ? body.kind : "human",
		});
		await addMessage(env.DB, roomId, {
			authorKind: "system",
			authorId: "system",
			targetKind: "system",
			targetId: null,
			body: `${joined.participant.displayName} joined the room.`,
			replyToId: null,
		});
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(
			{
				snapshot: snapshotForViewer(snapshot, joined.participant.id),
				participantId: joined.participant.id,
				participantToken: joined.participantToken,
			},
			201,
		);
	}

	const messagesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
	if (request.method === "POST" && messagesMatch) {
		const roomId = decodeURIComponent(messagesMatch[1] ?? "");
		const author = await requireRoomParticipant(env.DB, roomId, participantToken(request), false);
		const body = await readJson<{
			body?: string;
			targetKind?: MessageTargetKind;
			targetId?: string;
			replyToId?: string;
		}>(request);
		const text = clean(body.body, 2000);
		if (!text) throw new HttpError(400, "message is required");
		const targetKind = body.targetKind ?? (text.includes("@conductor") ? "conductor" : "room");
		await addMessage(env.DB, roomId, {
			authorKind: "human",
			authorId: author.id,
			targetKind,
			targetId: clean(body.targetId, 100) || null,
			body: text,
			replyToId: clean(body.replyToId, 100) || null,
		});
		if (targetKind === "conductor" || text.includes("@conductor")) {
			await conductorTurn(env, roomId, `${author.displayName}: ${text}`, author.id);
		}
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(snapshotForViewer(snapshot, author.id), 201);
	}

	const shuffleMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/shuffle$/);
	if (request.method === "POST" && shuffleMatch) {
		const roomId = decodeURIComponent(shuffleMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsPlanning(snapshot.room.status)) {
			throw new HttpError(409, "room is no longer accepting planning changes");
		}
		const active = snapshot.participants.filter((participant) => participant.kind !== "observer");
		const brief = shuffledBrief(`${roomId}:${snapshot.room.briefRevision + 1}`, active.length);
		const plan = planForParticipants(`${roomId}:${snapshot.room.briefRevision + 1}`, active);
		await setParticipantRoles(env.DB, plan.assignments);
		await clearRoomPlan(env.DB, roomId);
		await updateRoomBrief(env.DB, roomId, brief, "planning");
		await addMessage(env.DB, roomId, {
			authorKind: "conductor",
			authorId: "conductor",
			targetKind: "room",
			targetId: null,
			body: `Shuffled: ${brief.productGoal} Demo moment: ${brief.demoMoment}`,
			replyToId: null,
		});
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	const planMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/plan$/);
	if (request.method === "POST" && planMatch) {
		const roomId = decodeURIComponent(planMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsPlanning(snapshot.room.status)) {
			throw new HttpError(409, "room is no longer accepting planning changes");
		}
		const active = snapshot.participants.filter((participant) => participant.kind !== "observer");
		const plan = planForParticipants(snapshot.room.brief.ideaId || roomId, active);
		await setParticipantRoles(env.DB, plan.assignments);
		snapshot = await readRoomSnapshot(env.DB, roomId);
		await replacePlan(
			env.DB,
			roomId,
			{ ...plan.brief, ...snapshot.room.brief },
			snapshot.participants,
			plan.tasks,
		);
		await addMessage(env.DB, roomId, {
			authorKind: "conductor",
			authorId: "conductor",
			targetKind: "room",
			targetId: null,
			body: `Plan ready: ${active.length} lanes, explicit ownership, and one integration branch. Review it, then launch.`,
			replyToId: null,
		});
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	const approveMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/approve-plan$/);
	if (request.method === "POST" && approveMatch) {
		const roomId = decodeURIComponent(approveMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (["building", "integrating", "presenting", "ended"].includes(snapshot.room.status)) {
			return json(snapshotForViewer(snapshot, host.id));
		}
		if (snapshot.room.status === "provisioning") {
			throw new HttpError(409, "room provisioning is already in progress");
		}
		if (!snapshot.tasks.length) throw new HttpError(409, "draft a plan before launching");
		if (!(await approveRoomPlan(env.DB, roomId))) {
			throw new HttpError(409, "room is not ready to launch");
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		let bindings: Awaited<ReturnType<typeof provisionRoomCrabboxes>> = [];
		try {
			await ensureRoomBranches(env, snapshot.room, snapshot.participants);
			bindings = await provisionRoomCrabboxes(
				env,
				snapshot.room,
				snapshot.participants,
				snapshot.tasks,
			);
			for (const { participantId: id, binding } of bindings) {
				await updateParticipantRuntime(env.DB, id, {
					sessionId: binding.session.id,
					browserUrl: binding.browserUrl,
					summary: binding.session.summary,
					state: binding.session.status === "ready" ? "ready" : "working",
				});
			}
			const rootSessionId =
				bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id || null;
			await updateRoomRuntime(env.DB, roomId, rootSessionId, "building");
			await addMessage(env.DB, roomId, {
				authorKind: "system",
				authorId: "system",
				targetKind: "system",
				targetId: null,
				body: `${bindings.length} Codex workspace${bindings.length === 1 ? "" : "s"} launched.`,
				replyToId: null,
			});
		} catch (error) {
			const rootSessionId =
				bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id;
			if (rootSessionId) {
				await stopRoomCrabboxes(
					env,
					rootSessionId,
					bindings.map(({ binding }) => binding.session.id),
				).catch(() => undefined);
			}
			await resetRoomProvisioning(env.DB, roomId);
			throw error;
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(snapshotForViewer(snapshot, host.id));
	}

	const refreshMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/refresh$/);
	if (request.method === "POST" && refreshMatch) {
		const roomId = decodeURIComponent(refreshMatch[1] ?? "");
		const actor = await requireRoomParticipant(env.DB, roomId, participantToken(request));
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (snapshot.room.crabfleetRootSessionId) {
			const bindings = await readRoomCrabboxes(env, snapshot.room.crabfleetRootSessionId);
			for (const participant of snapshot.participants) {
				const binding = bindings.find((item) => item.session.id === participant.crabfleetSessionId);
				if (!binding) continue;
				await updateParticipantRuntime(env.DB, participant.id, {
					summary: binding.session.summary,
					state: binding.session.status === "ready" ? "working" : participant.state,
				});
			}
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(snapshotForViewer(snapshot, actor.id));
	}

	const nudgeMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/nudge$/);
	if (request.method === "POST" && nudgeMatch) {
		const roomId = decodeURIComponent(nudgeMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		const body = await readJson<{ participantId?: string; message?: string; reason?: string }>(
			request,
		);
		await nudgeParticipant(
			env,
			roomId,
			clean(body.participantId, 100),
			clean(body.message, 2000),
			clean(body.reason, 500),
		);
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(snapshotForViewer(snapshot, host.id));
	}

	const taskMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/tasks\/([^/]+)$/);
	if (request.method === "POST" && taskMatch) {
		const roomId = decodeURIComponent(taskMatch[1] ?? "");
		const actor = await requireRoomParticipant(env.DB, roomId, participantToken(request), false);
		const taskId = decodeURIComponent(taskMatch[2] ?? "");
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		const task = snapshot.tasks.find((item) => item.id === taskId);
		if (!task) throw new HttpError(404, "task not found");
		if (snapshot.room.status === "ended") throw new HttpError(409, "room has ended");
		if (actor.id !== snapshot.room.hostParticipantId && actor.id !== task.ownerParticipantId) {
			throw new HttpError(403, "only the task owner or host can update this task");
		}
		const body = await readJson<{ state?: TaskState }>(request);
		const states: TaskState[] = ["planned", "ready", "active", "blocked", "review", "done", "cut"];
		if (!body.state || !states.includes(body.state)) throw new HttpError(400, "invalid task state");
		await updateTaskState(env.DB, roomId, taskId, body.state);
		if (body.state === "blocked")
			await conductorTurn(
				env,
				roomId,
				`${actor.displayName} marked ${task.title} blocked`,
				actor.id,
			);
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, actor.id));
	}

	const presentMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/present$/);
	if (request.method === "POST" && presentMatch) {
		const roomId = decodeURIComponent(presentMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsPresentation(snapshot.room.status)) {
			throw new HttpError(409, "room is not ready to present");
		}
		await updateRoomRuntime(
			env.DB,
			roomId,
			(await readRoomSnapshot(env.DB, roomId)).room.crabfleetRootSessionId,
			"presenting",
		);
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	const endMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/end$/);
	if (request.method === "POST" && endMatch) {
		const roomId = decodeURIComponent(endMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		if (snapshot.room.crabfleetRootSessionId) {
			await stopRoomCrabboxes(
				env,
				snapshot.room.crabfleetRootSessionId,
				snapshot.participants.flatMap((item) =>
					item.crabfleetSessionId ? [item.crabfleetSessionId] : [],
				),
			);
		}
		await endRoom(env.DB, roomId);
		await addMessage(env.DB, roomId, {
			authorKind: "conductor",
			authorId: "conductor",
			targetKind: "room",
			targetId: null,
			body: "Room ended. The contribution timeline and final state are preserved for the recap.",
			replyToId: null,
		});
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	if (url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
	return env.ASSETS.fetch(request);
}

async function requireHost(db: D1Database, roomId: string, token: string): Promise<Participant> {
	const participant = await requireRoomParticipant(db, roomId, token, false);
	const snapshot = await readRoomSnapshot(db, roomId);
	if (snapshot.room.hostParticipantId !== participant.id)
		throw new HttpError(403, "host approval required");
	return participant;
}

async function conductorTurn(
	env: Env,
	roomId: string,
	trigger: string,
	actorParticipantId: string,
): Promise<void> {
	const snapshot = await readRoomSnapshot(env.DB, roomId);
	const tools: Parameters<typeof runConductorTurn>[3] = {
		postMessage: async (body) => {
			await addMessage(env.DB, roomId, {
				authorKind: "conductor",
				authorId: "conductor",
				targetKind: "room",
				targetId: null,
				body,
				replyToId: null,
			});
		},
		recordDecision: async (input) => {
			await addDecision(env.DB, roomId, {
				...input,
				authorKind: "conductor",
				authorId: "conductor",
				affectedTaskIds: [],
			});
		},
	};
	if (conductorCanNudge(snapshot, actorParticipantId)) {
		tools.nudge = async (input) =>
			nudgeParticipant(env, roomId, input.participantId, input.message, input.reason);
	}
	await runConductorTurn(env, snapshot, trigger, tools);
}

async function nudgeParticipant(
	env: Env,
	roomId: string,
	targetParticipantId: string,
	message: string,
	reason: string,
): Promise<void> {
	if (!targetParticipantId || !message || !reason)
		throw new HttpError(400, "participant, message, and reason are required");
	const snapshot = await readRoomSnapshot(env.DB, roomId);
	if (!roomAllowsRuntimeNudge(snapshot.room.status)) {
		throw new HttpError(409, "room runtime is not active");
	}
	const target = snapshot.participants.find(
		(participant) => participant.id === targetParticipantId,
	);
	if (!target?.crabfleetSessionId) throw new HttpError(400, "participant workspace is not ready");
	if (!snapshot.room.crabfleetRootSessionId) throw new HttpError(400, "room runtime is not ready");
	await sendCrabboxNudge(
		env,
		snapshot.room.crabfleetRootSessionId,
		target.crabfleetSessionId,
		message,
	);
	await addConductorAction(env.DB, roomId, {
		kind: "session_nudge",
		targetIds: [target.id],
		reason,
		evidenceRefs: [],
		approvalState: "not_required",
	});
	await addMessage(env.DB, roomId, {
		authorKind: "conductor",
		authorId: "conductor",
		targetKind: "participant",
		targetId: target.id,
		body: `Nudged ${target.displayName}: ${reason}`,
		replyToId: null,
	});
}

async function broadcastSnapshot(env: Env, snapshot: RoomSnapshot): Promise<void> {
	await env.ROOM_HUB.getByName(snapshot.room.id).broadcast(
		JSON.stringify({ type: "changed", roomId: snapshot.room.id, at: Date.now() }),
	);
}
