import { ideas, roles } from "./catalog.ts";
import { activeRoomLimit, eventAccessAuthorized } from "./access.ts";
import { runConductorTurn } from "./conductor.ts";
import {
	AmbiguousRootProvisioningError,
	PartialProvisioningError,
	participantStateForCrabfleetStatus,
	provisionRoomCrabboxes,
	readRoomCrabboxes,
	roomRootCrabboxRequest,
	sendCrabboxNudge,
	stopRoomCrabboxes,
} from "./crabfleet.ts";
import type { Participant, RoomSnapshot, RoomStatus, TaskState } from "./domain.ts";
import { ensureRoomBranches, resolveRepoDefaultBranch } from "./github.ts";
import {
	clean,
	HttpError,
	json,
	optionalParticipantToken,
	participantToken,
	readJson,
} from "./http.ts";
import { planForBrief, planForParticipants } from "./planning.ts";
import { repoAllowed } from "./repos.ts";
import { runtimeRedactor } from "./runtime-redaction.ts";
import {
	cleanupActionLeaseMilliseconds,
	provisioningLeaseMilliseconds,
	recoverPersistedRoomRootCrabbox,
} from "./runtime-cleanup.ts";
import {
	roomAllowsPlanning,
	roomAllowsPresentation,
	roomAllowsMessages,
	roomAllowsRuntimeRefresh,
	roomAllowsRuntimeNudge,
	roomPlanCoversActiveParticipants,
} from "./room-state.ts";
import { RoomHub } from "./room-hub.ts";
import {
	roomWebSocketSourceHeader,
	roomWebSocketTicketHeader,
	sameOriginWebSocketRequest,
} from "./socket-admission.ts";
import { requestSourceKey } from "./source-key.ts";
import {
	addConductorAction,
	addMessage,
	addParticipant,
	approveRoomPlan,
	beginRoomCleanup,
	claimConductorTurn,
	claimRoomRuntimeLease,
	claimRoomRuntimeRefresh,
	claimStaleProvisioningCleanup,
	completeRoomProvisioning,
	consumeRoomMessageBudget,
	createRoom,
	endRoom,
	expireInactivePrelaunchRooms,
	listRuntimeRoomIdsNeedingCleanup,
	markRootProvisioningAttempt,
	markRoomCleanup,
	readRoomMessagesPage,
	readRoomSnapshot,
	recordProvisioningBinding,
	refreshProvisioningBinding,
	releaseRoomCreationReservation,
	releaseRoomRuntimeLease,
	replayCreatedRoom,
	reserveRoomCreation,
	renewProvisioningLease,
	replacePlan,
	requireRoomParticipant,
	resetRoomProvisioning,
	roomBuilderInviteAuthorized,
	roomAcceptsWebSockets,
	roomMessageExists,
	roomRootProvisioningAttempted,
	upgradeObserverParticipant,
	updateParticipantRuntime,
	updateConductorActionApprovalState,
	updateRoomRuntime,
	updateTaskState,
	updateTaskStateWithDecision,
} from "./store.ts";
import { snapshotForViewer } from "./visibility.ts";

export { RoomHub };

const messageStatuses: RoomStatus[] = [
	"setup",
	"planning",
	"provisioning",
	"building",
	"integrating",
	"presenting",
];
const scopeChangeStatuses: RoomStatus[] = [
	"setup",
	"planning",
	"building",
	"integrating",
	"presenting",
];
const runtimeRefreshStatuses: RoomStatus[] = ["building", "integrating", "presenting"];
const runtimeNudgeStatuses: RoomStatus[] = ["building", "integrating"];
const runtimeActionLeaseMilliseconds = 30_000;
const runtimeRefreshCooldownMilliseconds = 15_000;
const roomCreationReservationMilliseconds = 60_000;
const prelaunchInactivityMilliseconds = 6 * 60 * 60 * 1000;
const scheduledReconciliationBudgetMilliseconds = 8 * 60 * 1000;
const prelaunchExpiryBatchSize = 1;
const roomMessageBudgetWindowMilliseconds = 10_000;
const maxRoomMessagesPerParticipantWindow = 10;

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
	async scheduled(_controller, env, context): Promise<void> {
		context.waitUntil(reconcileRooms(env));
	},
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
	if (request.method === "GET" && url.pathname === "/api/catalog") return json({ ideas, roles });

	if (request.method === "POST" && url.pathname === "/api/rooms") {
		if (
			!(await eventAccessAuthorized(
				request.headers.get("x-multicodex-event-code"),
				env.EVENT_ACCESS_CODE,
			))
		) {
			throw new HttpError(401, "valid event code required");
		}
		const body = await readJson<{
			title?: string;
			hostName?: string;
			repo?: string;
			durationMinutes?: number;
			requestId?: string;
		}>(request);
		const requestId = clean(body.requestId, 100);
		if (requestId.length < 20) throw new HttpError(400, "room creation request id is required");
		const replay = await replayCreatedRoom(env.DB, requestId);
		if (replay) {
			return json({
				snapshot: snapshotForViewer(replay.snapshot, replay.snapshot.room.hostParticipantId),
				participantId: replay.snapshot.room.hostParticipantId,
				participantToken: replay.participantToken,
				builderInviteToken: replay.builderInviteToken,
			});
		}
		const title = clean(body.title, 100) || "OpenAI event room";
		const hostName = clean(body.hostName, 80) || "Host";
		if (
			body.durationMinutes !== undefined &&
			(typeof body.durationMinutes !== "number" || !Number.isFinite(body.durationMinutes))
		) {
			throw new HttpError(400, "valid duration minutes required");
		}
		const durationMinutes = Math.max(5, Math.min(240, Math.floor(body.durationMinutes ?? 30)));
		const repo = clean(body.repo, 160) || env.DEFAULT_REPO || "vincentkoc/multicodex";
		if (!repoAllowed(repo, env.ALLOWED_REPOS, env.DEFAULT_REPO)) {
			throw new HttpError(400, "repo is not enabled for this MultiCodex deployment");
		}
		const roomLimit = activeRoomLimit(env.MAX_ACTIVE_ROOMS);
		const reservationLeaseId = await reserveRoomCreation(
			env.DB,
			requestId,
			roomLimit,
			Date.now() + roomCreationReservationMilliseconds,
		);
		if (!reservationLeaseId) {
			const replay = await replayCreatedRoom(env.DB, requestId);
			if (replay) {
				return json({
					snapshot: snapshotForViewer(replay.snapshot, replay.snapshot.room.hostParticipantId),
					participantId: replay.snapshot.room.hostParticipantId,
					participantToken: replay.participantToken,
					builderInviteToken: replay.builderInviteToken,
				});
			}
			throw new HttpError(429, "active room limit reached");
		}
		try {
			const baseBranch =
				String(env.MULTICODEX_SIMULATION_MODE) === "true"
					? clean(env.DEFAULT_BASE_BRANCH, 100) || "main"
					: await resolveRepoDefaultBranch(env, repo);
			const created = await createRoom(env.DB, {
				title,
				hostName,
				repo,
				baseBranch,
				durationMinutes,
				activeRoomLimit: roomLimit,
				requestId,
			});
			context.waitUntil(broadcastSnapshot(env, created.snapshot));
			return json(
				{
					snapshot: snapshotForViewer(created.snapshot, created.snapshot.room.hostParticipantId),
					participantId: created.snapshot.room.hostParticipantId,
					participantToken: created.participantToken,
					builderInviteToken: created.builderInviteToken,
				},
				201,
			);
		} finally {
			await releaseRoomCreationReservation(env.DB, requestId, reservationLeaseId);
		}
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
		if (!sameOriginWebSocketRequest(request)) {
			throw new HttpError(403, "same-origin websocket required");
		}
		const roomId = decodeURIComponent(roomWsMatch[1] ?? "");
		if (!(await roomAcceptsWebSockets(env.DB, roomId))) {
			throw new HttpError(409, "room is not accepting sockets");
		}
		const headers = new Headers(request.headers);
		headers.set(roomWebSocketSourceHeader, await requestSourceKey(request));
		headers.delete(roomWebSocketTicketHeader);
		const ticket = clean(url.searchParams.get("ticket"), 100);
		if (ticket) headers.set(roomWebSocketTicketHeader, ticket);
		return env.ROOM_HUB.getByName(roomId).fetch(new Request(request, { headers }));
	}

	const socketTicketMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/socket-ticket$/);
	if (request.method === "POST" && socketTicketMatch) {
		const roomId = decodeURIComponent(socketTicketMatch[1] ?? "");
		const participant = await requireRoomParticipant(env.DB, roomId, participantToken(request));
		const ticket = await env.ROOM_HUB.getByName(roomId).issueParticipantTicket(
			participant.id,
			participant.kind,
		);
		return json({ ticket }, 201);
	}

	const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
	if (request.method === "POST" && joinMatch) {
		const roomId = decodeURIComponent(joinMatch[1] ?? "");
		const body = await readJson<{
			displayName?: string;
			githubLogin?: string;
			kind?: "human" | "ai" | "observer";
			requestId?: string;
			inviteToken?: string;
		}>(request);
		const displayName = clean(body.displayName, 80);
		if (!displayName) throw new HttpError(400, "display name is required");
		const requestId = clean(body.requestId, 100);
		if (requestId.length < 20) throw new HttpError(400, "join request id is required");
		const kind: Participant["kind"] =
			body.kind === "observer" || body.kind === "ai" ? body.kind : "human";
		const inviteToken = clean(body.inviteToken, 100);
		if (!(await roomBuilderInviteAuthorized(env.DB, roomId, inviteToken))) {
			throw new HttpError(401, "valid room invite required for a participant seat");
		}
		const currentToken = optionalParticipantToken(request);
		const current = currentToken
			? await requireRoomParticipant(env.DB, roomId, currentToken)
			: null;
		const joinInput = {
			displayName,
			githubLogin: clean(body.githubLogin, 80) || null,
			kind,
			requestId,
			maxAiSeats: roles.filter((role) => role.suitableForAISeat).length,
		};
		const joined = current
			? await upgradeObserverParticipant(env.DB, roomId, current.id, joinInput)
			: await addParticipant(env.DB, roomId, joinInput);
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
	if (request.method === "GET" && messagesMatch) {
		const roomId = decodeURIComponent(messagesMatch[1] ?? "");
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		const token = optionalParticipantToken(request);
		const viewer = token ? await requireRoomParticipant(env.DB, roomId, token) : null;
		const beforeValue = url.searchParams.get("before");
		const beforeId = clean(url.searchParams.get("beforeId"), 100);
		const beforeCreatedAt = beforeValue === null ? null : Number(beforeValue);
		if (
			(beforeCreatedAt !== null || beforeId) &&
			(!Number.isSafeInteger(beforeCreatedAt) || Number(beforeCreatedAt) < 0 || !beforeId)
		) {
			throw new HttpError(400, "valid message cursor required");
		}
		const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
		if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
			throw new HttpError(400, "valid message limit required");
		}
		const messages = await readRoomMessagesPage(
			env.DB,
			roomId,
			beforeCreatedAt === null ? null : { createdAt: beforeCreatedAt, id: beforeId },
			Math.min(100, requestedLimit),
		);
		const visible = snapshotForViewer({ ...snapshot, messages }, viewer?.id);
		return json({ messages: visible.messages, messageCount: snapshot.messageCount });
	}
	if (request.method === "POST" && messagesMatch) {
		const roomId = decodeURIComponent(messagesMatch[1] ?? "");
		const author = await requireRoomParticipant(env.DB, roomId, participantToken(request), false);
		if (
			!(await consumeRoomMessageBudget(
				env.DB,
				roomId,
				author.id,
				Date.now(),
				maxRoomMessagesPerParticipantWindow,
				roomMessageBudgetWindowMilliseconds,
			))
		) {
			throw new HttpError(429, "message rate exceeded");
		}
		const current = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsMessages(current.room.status)) {
			throw new HttpError(409, "room messages are closed");
		}
		const body = await readJson<{
			body?: unknown;
			targetKind?: unknown;
			targetId?: unknown;
			replyToId?: unknown;
		}>(request);
		const text = clean(body.body, 2000);
		if (!text) throw new HttpError(400, "message is required");
		const targetKind = participantMessageTargetKind(body.targetKind, text);
		const targetId = optionalMessageReference(body.targetId, "message target");
		const replyToId = optionalMessageReference(body.replyToId, "message reply");
		if (targetKind === "participant") {
			if (!targetId || !current.participants.some((participant) => participant.id === targetId)) {
				throw new HttpError(400, "message target is not in this room");
			}
		} else if (targetId) {
			throw new HttpError(400, "message target id is not valid for this target kind");
		}
		if (replyToId && !(await roomMessageExists(env.DB, roomId, replyToId))) {
			throw new HttpError(400, "message reply is not in this room");
		}
		if (
			!(await addMessage(
				env.DB,
				roomId,
				{
					authorKind: author.kind === "ai" ? "ai" : "human",
					authorId: author.id,
					targetKind,
					targetId,
					body: text,
					replyToId,
				},
				messageStatuses,
			))
		) {
			throw new HttpError(409, "room messages are closed");
		}
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		if (targetKind === "conductor" || text.includes("@conductor")) {
			context.waitUntil(
				conductorTurnBestEffort(env, roomId, `${author.displayName}: ${text}`, author.id),
			);
		}
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
		const plan = planForParticipants(`${roomId}:${snapshot.room.briefRevision + 1}`, active);
		const participants = participantsWithAssignments(snapshot.participants, plan.assignments);
		const installedRevision = await replacePlan(
			env.DB,
			roomId,
			snapshot.room.briefRevision,
			plan.brief,
			participants,
			[],
		);
		if (installedRevision === null) {
			throw new HttpError(409, "room is no longer accepting planning changes");
		}
		if (
			!(await addMessage(
				env.DB,
				roomId,
				{
					authorKind: "conductor",
					authorId: "conductor",
					targetKind: "room",
					targetId: null,
					body: `Shuffled: ${plan.brief.productGoal} Demo moment: ${plan.brief.demoMoment}`,
					replyToId: null,
				},
				["planning"],
				installedRevision,
			))
		) {
			throw new HttpError(409, "room closed before the shuffled plan could be announced");
		}
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	const planMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/plan$/);
	if (request.method === "POST" && planMatch) {
		const roomId = decodeURIComponent(planMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsPlanning(snapshot.room.status)) {
			throw new HttpError(409, "room is no longer accepting planning changes");
		}
		if (!snapshot.room.brief.productGoal?.trim()) {
			throw new HttpError(409, "shuffle an idea before drafting the plan");
		}
		const active = snapshot.participants.filter((participant) => participant.kind !== "observer");
		const plan = planForBrief(snapshot.room.brief, active);
		const participants = participantsWithAssignments(snapshot.participants, plan.assignments);
		const installedRevision = await replacePlan(
			env.DB,
			roomId,
			snapshot.room.briefRevision,
			plan.brief,
			participants,
			plan.tasks,
		);
		if (installedRevision === null) {
			throw new HttpError(409, "room is no longer accepting planning changes");
		}
		if (
			!(await addMessage(
				env.DB,
				roomId,
				{
					authorKind: "conductor",
					authorId: "conductor",
					targetKind: "room",
					targetId: null,
					body: `Plan ready: ${active.length} lanes, explicit ownership, and one integration branch. Review it, then launch.`,
					replyToId: null,
				},
				["planning"],
				installedRevision,
			))
		) {
			throw new HttpError(409, "room closed before the plan could be announced");
		}
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
		if (!roomPlanCoversActiveParticipants(snapshot)) {
			throw new HttpError(409, "draft a current role and task for every active participant");
		}
		if (!repoAllowed(snapshot.room.repo, env.ALLOWED_REPOS, env.DEFAULT_REPO)) {
			throw new HttpError(403, "room repository is no longer enabled");
		}
		const launchRevision = snapshot.room.briefRevision;
		if (!(await approveRoomPlan(env.DB, roomId, launchRevision))) {
			throw new HttpError(409, "room is not ready to launch");
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		let bindings: Awaited<ReturnType<typeof provisionRoomCrabboxes>> = [];
		let nextProvisioningLeaseRenewalAt = Date.now() + Math.floor(provisioningLeaseMilliseconds / 2);
		const renewLaunchLease = async () => {
			if (Date.now() < nextProvisioningLeaseRenewalAt) return;
			if (!(await renewProvisioningLease(env.DB, roomId, launchRevision))) {
				throw new HttpError(409, "room launch was cancelled");
			}
			nextProvisioningLeaseRenewalAt = Date.now() + Math.floor(provisioningLeaseMilliseconds / 2);
		};
		try {
			await ensureRoomBranches(env, snapshot.room, snapshot.participants, renewLaunchLease);
			const rootRequest = roomRootCrabboxRequest(
				env,
				snapshot.room,
				snapshot.participants,
				snapshot.tasks,
			);
			if (
				!(await markRootProvisioningAttempt(
					env.DB,
					roomId,
					launchRevision,
					JSON.stringify(rootRequest),
				))
			) {
				throw new AmbiguousRootProvisioningError();
			}
			bindings = await provisionRoomCrabboxes(
				env,
				snapshot.room,
				snapshot.participants,
				snapshot.tasks,
				async ({ participantId, binding }, _bindings, stage) => {
					const rootSessionId = binding.session.rootSessionId || binding.session.id;
					const persist =
						stage === "created" ? recordProvisioningBinding : refreshProvisioningBinding;
					if (
						!(await persist(env.DB, roomId, launchRevision, rootSessionId, {
							participantId,
							sessionId: binding.session.id,
							browserUrl: binding.browserUrl,
							summary: binding.session.summary,
							state: binding.session.status === "ready" ? "ready" : "working",
						}))
					) {
						throw new HttpError(409, "room launch was cancelled");
					}
				},
				rootRequest,
			);
			const rootSessionId =
				bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id;
			if (!rootSessionId) throw new HttpError(502, "room launch did not return a root workspace");
			if (
				!(await addMessage(
					env.DB,
					roomId,
					{
						authorKind: "system",
						authorId: "system",
						targetKind: "system",
						targetId: null,
						body: `${bindings.length} Codex workspace${bindings.length === 1 ? "" : "s"} launched.`,
						replyToId: null,
					},
					["provisioning"],
					launchRevision,
				))
			) {
				throw new HttpError(409, "room launch was cancelled");
			}
			if (!(await completeRoomProvisioning(env.DB, roomId, launchRevision, rootSessionId))) {
				throw new HttpError(409, "room launch was cancelled");
			}
		} catch (error) {
			if (error instanceof PartialProvisioningError) bindings = error.bindings;
			if (!(error instanceof AmbiguousRootProvisioningError)) {
				const rootSessionId =
					bindings[0]?.binding.session.rootSessionId || bindings[0]?.binding.session.id || null;
				const launchCommitted = await env.ROOM_HUB.getByName(roomId).cleanupFailedLaunch(
					roomId,
					launchRevision,
					rootSessionId,
				);
				if (launchCommitted) {
					snapshot = await readRoomSnapshot(env.DB, roomId);
					context.waitUntil(broadcastSnapshot(env, snapshot));
					return json(snapshotForViewer(snapshot, host.id));
				}
			}
			throw error;
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, snapshot));
		return json(snapshotForViewer(snapshot, host.id));
	}

	const refreshMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/refresh$/);
	if (request.method === "POST" && refreshMatch) {
		const roomId = decodeURIComponent(refreshMatch[1] ?? "");
		const actor = await requireRoomParticipant(env.DB, roomId, participantToken(request), false);
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsRuntimeRefresh(snapshot.room.status)) {
			throw new HttpError(409, "room runtime is not active");
		}
		if (
			!(await claimRoomRuntimeRefresh(
				env.DB,
				roomId,
				Date.now(),
				runtimeRefreshCooldownMilliseconds,
			))
		) {
			throw new HttpError(429, "room runtime refresh is cooling down");
		}
		if (snapshot.room.crabfleetRootSessionId) {
			const bindings = await readRoomCrabboxes(env, snapshot.room.crabfleetRootSessionId);
			for (const participant of snapshot.participants) {
				const binding = bindings.find((item) => item.session.id === participant.crabfleetSessionId);
				if (!binding) continue;
				await updateParticipantRuntime(
					env.DB,
					participant.id,
					{
						summary: binding.session.summary,
						state: participantStateForCrabfleetStatus(binding.session.status, participant.state),
					},
					{ roomId, expectedStatuses: runtimeRefreshStatuses },
				);
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
		let durableSnapshot: RoomSnapshot | null = null;
		try {
			await nudgeParticipant(
				env,
				roomId,
				clean(body.participantId, 100),
				clean(body.message, 2000),
				clean(body.reason, 500),
			);
		} finally {
			durableSnapshot = await readRoomSnapshot(env.DB, roomId);
			context.waitUntil(broadcastSnapshot(env, durableSnapshot));
		}
		return json(snapshotForViewer(durableSnapshot, host.id));
	}

	const taskMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/tasks\/([^/]+)$/);
	if (request.method === "POST" && taskMatch) {
		const roomId = decodeURIComponent(taskMatch[1] ?? "");
		const actor = await requireRoomParticipant(env.DB, roomId, participantToken(request), false);
		const taskId = decodeURIComponent(taskMatch[2] ?? "");
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		const task = snapshot.tasks.find((item) => item.id === taskId);
		if (!task) throw new HttpError(404, "task not found");
		if (["cleanup-planning", "cleanup-ending", "ended"].includes(snapshot.room.status)) {
			throw new HttpError(409, "room is no longer accepting task updates");
		}
		if (actor.id !== snapshot.room.hostParticipantId && actor.id !== task.ownerParticipantId) {
			throw new HttpError(403, "only the task owner or host can update this task");
		}
		const body = await readJson<{ state?: TaskState }>(request);
		const states: TaskState[] = ["planned", "ready", "active", "blocked", "review", "done", "cut"];
		if (!body.state || !states.includes(body.state)) throw new HttpError(400, "invalid task state");
		const scopeChange = body.state === "cut" || task.state === "cut";
		if (scopeChange && actor.id !== snapshot.room.hostParticipantId) {
			throw new HttpError(403, "host approval required to cut a task");
		}
		const restoring = task.state === "cut";
		const allowedStatuses = scopeChange ? scopeChangeStatuses : messageStatuses;
		const taskUpdated =
			scopeChange && body.state !== task.state
				? await updateTaskStateWithDecision(
						env.DB,
						roomId,
						taskId,
						body.state,
						task.state,
						allowedStatuses,
						{
							title: `${restoring ? "Restore" : "Cut"} ${task.title}`,
							decision: `${task.title} was ${restoring ? "restored to" : "removed from"} the room scope.`,
							reason: `Host approved the scope ${restoring ? "restoration" : "cut"}.`,
							authorKind: "human",
							authorId: actor.id,
							affectedTaskIds: [task.id],
						},
					)
				: await updateTaskState(env.DB, roomId, taskId, body.state, task.state, allowedStatuses);
		if (!taskUpdated) {
			throw new HttpError(409, "room is no longer accepting task updates");
		}
		if (body.state === "blocked")
			context.waitUntil(
				conductorTurnBestEffort(
					env,
					roomId,
					`${actor.displayName} marked ${task.title} blocked`,
					actor.id,
				),
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
		if (
			!(await updateRoomRuntime(
				env.DB,
				roomId,
				snapshot.room.crabfleetRootSessionId,
				"presenting",
				["building", "integrating"],
			))
		) {
			throw new HttpError(409, "room state changed before presentation");
		}
		const updated = await readRoomSnapshot(env.DB, roomId);
		context.waitUntil(broadcastSnapshot(env, updated));
		return json(snapshotForViewer(updated, host.id));
	}

	const retryCleanupMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/retry-cleanup$/);
	if (request.method === "POST" && retryCleanupMatch) {
		const roomId = decodeURIComponent(retryCleanupMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (snapshot.room.status === "provisioning") {
			if (
				!(await claimStaleProvisioningCleanup(
					env.DB,
					roomId,
					Date.now() - provisioningLeaseMilliseconds,
				))
			) {
				throw new HttpError(409, "room provisioning is still active");
			}
			snapshot = await readRoomSnapshot(env.DB, roomId);
			context.waitUntil(broadcastSnapshot(env, snapshot));
		}
		if (snapshot.room.status !== "cleanup-planning") {
			throw new HttpError(409, "room is not waiting for launch cleanup");
		}
		const cleanupLeaseId = await claimRoomRuntimeLease(
			env.DB,
			roomId,
			"launch_cleanup",
			["cleanup-planning"],
			cleanupActionLeaseMilliseconds,
		);
		if (!cleanupLeaseId) throw new HttpError(409, "room cleanup is already active");
		try {
			if (
				!snapshot.room.crabfleetRootSessionId &&
				(await roomRootProvisioningAttempted(env.DB, roomId))
			) {
				const root = await recoverPersistedRoomRootCrabbox(env, snapshot);
				if (root) {
					if (
						!(await markRoomCleanup(
							env.DB,
							roomId,
							snapshot.room.briefRevision,
							root.binding.session.rootSessionId || root.binding.session.id,
							"cleanup-planning",
							["cleanup-planning"],
							[
								{
									participantId: root.participantId,
									sessionId: root.binding.session.id,
									browserUrl: root.binding.browserUrl,
									summary: root.binding.session.summary,
									state: participantStateForCrabfleetStatus(root.binding.session.status, "joined"),
								},
							],
						))
					) {
						throw new HttpError(409, "room cleanup state changed during root recovery");
					}
					snapshot = await readRoomSnapshot(env.DB, roomId);
					context.waitUntil(broadcastSnapshot(env, snapshot));
				}
			}
			if (snapshot.room.crabfleetRootSessionId) {
				await stopRoomCrabboxes(
					env,
					snapshot.room.crabfleetRootSessionId,
					snapshot.participants.flatMap((item) =>
						item.crabfleetSessionId ? [item.crabfleetSessionId] : [],
					),
				);
			}
			if (
				!(await resetRoomProvisioning(
					env.DB,
					roomId,
					["cleanup-planning"],
					snapshot.room.briefRevision,
				))
			) {
				throw new HttpError(409, "room cleanup state changed before reset");
			}
			snapshot = await readRoomSnapshot(env.DB, roomId);
			context.waitUntil(broadcastSnapshot(env, snapshot));
			return json(snapshotForViewer(snapshot, host.id));
		} finally {
			await releaseRoomRuntimeLease(env.DB, roomId, cleanupLeaseId);
		}
	}

	const endMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/end$/);
	if (request.method === "POST" && endMatch) {
		const roomId = decodeURIComponent(endMatch[1] ?? "");
		const host = await requireHost(env.DB, roomId, participantToken(request));
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (snapshot.room.status === "ended") return json(snapshotForViewer(snapshot, host.id));
		if (snapshot.room.status === "provisioning") {
			throw new HttpError(409, "active provisioning can be cancelled after its lease expires");
		}
		const runtimeMayExist =
			snapshot.room.crabfleetRootSessionId !== null ||
			(await roomRootProvisioningAttempted(env.DB, roomId));
		const endableStatuses = [
			"setup",
			"planning",
			"building",
			"integrating",
			"presenting",
			"cleanup-ending",
		] as const;
		const cleanupLeaseId = await beginRoomCleanup(
			env.DB,
			roomId,
			snapshot.room.crabfleetRootSessionId,
			[...endableStatuses],
			cleanupActionLeaseMilliseconds,
		);
		if (!cleanupLeaseId) {
			throw new HttpError(409, "room state changed before cleanup");
		}
		try {
			snapshot = await readRoomSnapshot(env.DB, roomId);
			context.waitUntil(broadcastSnapshot(env, snapshot));
			if (!snapshot.room.crabfleetRootSessionId && runtimeMayExist) {
				const root = await recoverPersistedRoomRootCrabbox(env, snapshot);
				if (root) {
					if (
						!(await markRoomCleanup(
							env.DB,
							roomId,
							snapshot.room.briefRevision,
							root.binding.session.rootSessionId || root.binding.session.id,
							"cleanup-ending",
							["cleanup-ending"],
							[
								{
									participantId: root.participantId,
									sessionId: root.binding.session.id,
									browserUrl: root.binding.browserUrl,
									summary: root.binding.session.summary,
									state: participantStateForCrabfleetStatus(root.binding.session.status, "joined"),
								},
							],
						))
					) {
						throw new HttpError(409, "room cleanup state changed during root recovery");
					}
					snapshot = await readRoomSnapshot(env.DB, roomId);
				}
			}
			if (snapshot.room.crabfleetRootSessionId) {
				await stopRoomCrabboxes(
					env,
					snapshot.room.crabfleetRootSessionId,
					snapshot.participants.flatMap((item) =>
						item.crabfleetSessionId ? [item.crabfleetSessionId] : [],
					),
				);
			}
			if (await endRoom(env.DB, roomId)) {
				await addMessage(env.DB, roomId, {
					authorKind: "conductor",
					authorId: "conductor",
					targetKind: "room",
					targetId: null,
					body: "Room ended. The contribution timeline and final state are preserved for the recap.",
					replyToId: null,
				});
			}
			const updated = await readRoomSnapshot(env.DB, roomId);
			context.waitUntil(broadcastSnapshot(env, updated));
			return json(snapshotForViewer(updated, host.id));
		} finally {
			await releaseRoomRuntimeLease(env.DB, roomId, cleanupLeaseId);
		}
	}

	if (url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
	return assetResponse(env, request);
}

async function assetResponse(env: Env, request: Request): Promise<Response> {
	const response = await env.ASSETS.fetch(request);
	const headers = new Headers(response.headers);
	headers.set("content-security-policy", "frame-ancestors 'none'");
	headers.set("x-frame-options", "DENY");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function participantMessageTargetKind(
	value: unknown,
	text: string,
): "room" | "conductor" | "participant" {
	if (value === undefined) return text.includes("@conductor") ? "conductor" : "room";
	if (value === "room" || value === "conductor" || value === "participant") return value;
	throw new HttpError(400, "valid message target kind required");
}

function optionalMessageReference(value: unknown, label: string): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") throw new HttpError(400, `${label} is invalid`);
	const reference = clean(value, 100);
	if (!reference || reference !== value) throw new HttpError(400, `${label} is invalid`);
	return reference;
}

async function reconcileRooms(env: Env): Promise<void> {
	const now = Date.now();
	const deadline = now + scheduledReconciliationBudgetMilliseconds;
	for (const roomId of await expireInactivePrelaunchRooms(
		env.DB,
		now - prelaunchInactivityMilliseconds,
		prelaunchExpiryBatchSize,
	)) {
		if (Date.now() >= deadline) return;
		try {
			await addMessage(env.DB, roomId, {
				authorKind: "system",
				authorId: "system",
				targetKind: "room",
				targetId: null,
				body: "Room expired after six hours without planning activity.",
				replyToId: null,
			});
			await broadcastSnapshot(env, await readRoomSnapshot(env.DB, roomId));
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "prelaunch_room_expiry_broadcast_failed",
					roomId,
					message: error instanceof Error ? error.message : "unknown error",
				}),
			);
		}
	}
	if (Date.now() >= deadline) return;
	const roomIds = await listRuntimeRoomIdsNeedingCleanup(
		env.DB,
		now,
		now - provisioningLeaseMilliseconds,
		activeRoomLimit(env.MAX_ACTIVE_ROOMS),
	);
	await reconcileRuntimeRooms(env, roomIds, deadline);
}

async function reconcileRuntimeRooms(env: Env, roomIds: string[], deadline: number): Promise<void> {
	await Promise.all(
		roomIds.map(async (roomId) => {
			if (Date.now() >= deadline) return;
			try {
				await env.ROOM_HUB.getByName(roomId).reconcileRuntime(roomId);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "room_cleanup_reconciliation_failed",
						roomId,
						message: error instanceof Error ? error.message : "unknown error",
					}),
				);
			}
		}),
	);
}

function participantsWithAssignments(
	participants: Participant[],
	assignments: Array<{ participantId: string; roleId: string }>,
): Participant[] {
	const roles = new Map(
		assignments.map((assignment) => [assignment.participantId, assignment.roleId]),
	);
	return participants.map((participant) => ({
		...participant,
		roleId: roles.get(participant.id) ?? participant.roleId,
	}));
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
	if (!(await claimConductorTurn(env.DB, roomId, actorParticipantId))) return;
	const snapshot = await readRoomSnapshot(env.DB, roomId);
	const tools: Parameters<typeof runConductorTurn>[3] = {
		postMessage: async (body) => {
			await addMessage(
				env.DB,
				roomId,
				{
					authorKind: "conductor",
					authorId: "conductor",
					targetKind: "room",
					targetId: null,
					body,
					replyToId: null,
				},
				messageStatuses,
			);
		},
	};
	await runConductorTurn(env, snapshot, trigger, tools);
}

async function conductorTurnBestEffort(
	env: Env,
	roomId: string,
	trigger: string,
	actorParticipantId: string,
): Promise<void> {
	try {
		await conductorTurn(env, roomId, trigger, actorParticipantId);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "conductor_turn_failed",
				roomId,
				message: error instanceof Error ? error.message : "unknown error",
			}),
		);
	} finally {
		try {
			await broadcastSnapshot(env, await readRoomSnapshot(env.DB, roomId));
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "conductor_broadcast_failed",
					roomId,
					message: error instanceof Error ? error.message : "unknown error",
				}),
			);
		}
	}
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
	let snapshot = await readRoomSnapshot(env.DB, roomId);
	if (!roomAllowsRuntimeNudge(snapshot.room.status)) {
		throw new HttpError(409, "room runtime is not active");
	}
	let target = snapshot.participants.find((participant) => participant.id === targetParticipantId);
	if (!target?.crabfleetSessionId) throw new HttpError(400, "participant workspace is not ready");
	if (!snapshot.room.crabfleetRootSessionId) throw new HttpError(400, "room runtime is not ready");
	const leaseId = await claimRoomRuntimeLease(
		env.DB,
		roomId,
		"session_nudge",
		runtimeNudgeStatuses,
		runtimeActionLeaseMilliseconds,
	);
	if (!leaseId) throw new HttpError(409, "room runtime is busy or ending");
	try {
		snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!roomAllowsRuntimeNudge(snapshot.room.status)) {
			throw new HttpError(409, "room runtime is not active");
		}
		target = snapshot.participants.find((participant) => participant.id === targetParticipantId);
		if (!target?.crabfleetSessionId) {
			throw new HttpError(400, "participant workspace is not ready");
		}
		if (!snapshot.room.crabfleetRootSessionId) {
			throw new HttpError(400, "room runtime is not ready");
		}
		const redact = runtimeRedactor(snapshot);
		const auditedMessage = clean(redact(message), 2000);
		const auditedReason = clean(redact(reason), 500);
		const auditDetail = `Instruction: ${auditedMessage} Reason: ${auditedReason}`;
		const actionId = await addConductorAction(env.DB, roomId, {
			kind: "session_nudge",
			targetIds: [target.id],
			reason: auditDetail,
			evidenceRefs: [],
			approvalState: "requested",
		});
		try {
			await sendCrabboxNudge(
				env,
				snapshot.room.crabfleetRootSessionId,
				target.crabfleetSessionId,
				message,
			);
		} catch (error) {
			await updateConductorActionApprovalState(env.DB, roomId, actionId, "delivery_unknown").catch(
				() => undefined,
			);
			throw error;
		}
		if (!(await updateConductorActionApprovalState(env.DB, roomId, actionId, "approved"))) {
			throw new HttpError(409, "nudge delivery record changed");
		}
		await addMessage(env.DB, roomId, {
			authorKind: "conductor",
			authorId: "conductor",
			targetKind: "participant",
			targetId: target.id,
			body: `Nudged ${target.displayName}: ${auditDetail}`,
			replyToId: null,
		});
	} finally {
		await releaseRoomRuntimeLease(env.DB, roomId, leaseId);
	}
}

async function broadcastSnapshot(env: Env, snapshot: RoomSnapshot): Promise<void> {
	await env.ROOM_HUB.getByName(snapshot.room.id).broadcast(
		JSON.stringify({ type: "changed", roomId: snapshot.room.id, at: Date.now() }),
	);
}
