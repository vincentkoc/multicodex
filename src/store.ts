import type {
	ConductorAction,
	Decision,
	MessageTargetKind,
	Participant,
	ParticipantKind,
	Room,
	RoomBrief,
	RoomMessage,
	RoomSnapshot,
	RoomStatus,
	Task,
	TaskState,
} from "./domain.ts";
import { encodeJson, HttpError, newId, parseJson, slugify } from "./http.ts";
import { roomAllowsPlanning } from "./room-state.ts";

type RoomRow = {
	id: string;
	slug: string;
	title: string;
	status: RoomStatus;
	host_participant_id: string;
	repo: string;
	base_branch: string;
	integration_branch: string;
	crabfleet_root_session_id: string | null;
	creation_request_id: string | null;
	brief_json: string;
	brief_revision: number;
	duration_minutes: number;
	started_at: number | null;
	ends_at: number | null;
	created_at: number;
	updated_at: number;
};

type ParticipantRow = {
	id: string;
	room_id: string;
	kind: ParticipantKind;
	display_name: string;
	github_login: string | null;
	role_id: string | null;
	task_id: string | null;
	crabfleet_session_id: string | null;
	browser_url: string | null;
	runtime_summary: string;
	branch: string | null;
	state: Participant["state"];
	access_token: string | null;
	join_request_id: string | null;
	joined_at: number | null;
	created_at: number;
	updated_at: number;
};

type MessageRow = {
	id: string;
	room_id: string;
	author_kind: RoomMessage["authorKind"];
	author_id: string;
	target_kind: MessageTargetKind;
	target_id: string | null;
	body: string;
	reply_to_id: string | null;
	created_at: number;
};

type TaskRow = {
	id: string;
	room_id: string;
	title: string;
	description: string;
	owner_participant_id: string | null;
	state: TaskState;
	depends_on_json: string;
	owns_paths_json: string;
	acceptance_criteria_json: string;
	branch: string | null;
	pull_request_url: string | null;
	created_at: number;
	updated_at: number;
};

type DecisionRow = {
	id: string;
	room_id: string;
	title: string;
	decision: string;
	reason: string;
	author_kind: Decision["authorKind"];
	author_id: string;
	affected_task_ids_json: string;
	created_at: number;
};

type ActionRow = {
	id: string;
	room_id: string;
	kind: string;
	target_ids_json: string;
	reason: string;
	evidence_refs_json: string;
	approval_state: ConductorAction["approvalState"];
	created_at: number;
};

export async function createRoom(
	db: D1Database,
	input: {
		title: string;
		hostName: string;
		repo: string;
		baseBranch: string;
		durationMinutes: number;
		activeRoomLimit: number;
		staleBefore: number;
		requestId: string;
	},
): Promise<{ snapshot: RoomSnapshot; participantToken: string }> {
	const replay = await replayCreatedRoom(db, input.requestId);
	if (replay) return replay;
	const now = Date.now();
	const roomId = newId("room");
	const hostId = newId("person");
	const participantToken = newId("seat");
	const slug = `${slugify(input.title).slice(0, 40)}-${roomId.slice(-6)}`;
	const integrationBranch = `multicodex/${slug}/integration`;
	const [, roomResult] = await db.batch([
		db
			.prepare(
				`UPDATE rooms SET status = 'ended', updated_at = ?
         WHERE status IN ('setup', 'planning') AND updated_at < ?`,
			)
			.bind(now, input.staleBefore),
		db
			.prepare(
				`INSERT OR IGNORE INTO rooms
          (id, slug, title, status, host_participant_id, repo, base_branch, integration_branch,
           creation_request_id, duration_minutes, created_at, updated_at)
         SELECT ?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM rooms WHERE status != 'ended'
         ) < ?`,
			)
			.bind(
				roomId,
				slug,
				input.title,
				hostId,
				input.repo,
				input.baseBranch,
				integrationBranch,
				input.requestId,
				input.durationMinutes,
				now,
				now,
				input.activeRoomLimit,
			),
		db
			.prepare(
				`INSERT INTO participants
          (id, room_id, kind, display_name, role_id, access_token, branch, state, joined_at, created_at, updated_at)
         SELECT ?, id, 'human', ?, 'product-integration', ?, ?, 'joined', ?, ?, ?
         FROM rooms WHERE id = ?`,
			)
			.bind(hostId, input.hostName, participantToken, integrationBranch, now, now, now, roomId),
		db
			.prepare(
				`INSERT INTO room_messages
          (id, room_id, author_kind, author_id, target_kind, body, created_at)
         SELECT ?, id, 'conductor', 'conductor', 'room', ?, ?
         FROM rooms WHERE id = ?`,
			)
			.bind(
				newId("msg"),
				`Welcome, ${input.hostName}. Invite the team or shuffle a build idea when you are ready.`,
				now,
				roomId,
			),
	]);
	if (roomResult?.meta.changes !== 1) {
		const replay = await replayCreatedRoom(db, input.requestId);
		if (replay) return replay;
		throw new HttpError(429, "active room limit reached");
	}
	return { snapshot: await readRoomSnapshot(db, roomId), participantToken };
}

export async function replayCreatedRoom(
	db: D1Database,
	requestId: string,
): Promise<{ snapshot: RoomSnapshot; participantToken: string } | null> {
	const room = await db
		.prepare("SELECT id, host_participant_id FROM rooms WHERE creation_request_id = ?")
		.bind(requestId)
		.first<{ id: string; host_participant_id: string }>();
	if (!room) return null;
	const host = await db
		.prepare("SELECT access_token FROM participants WHERE id = ? AND room_id = ?")
		.bind(room.host_participant_id, room.id)
		.first<{ access_token: string | null }>();
	if (!host?.access_token) throw new HttpError(409, "room creation is incomplete");
	return { snapshot: await readRoomSnapshot(db, room.id), participantToken: host.access_token };
}

export async function readRoomSnapshot(db: D1Database, roomId: string): Promise<RoomSnapshot> {
	const [
		roomResult,
		participants,
		messages,
		tasks,
		decisions,
		conductorActions,
		runtimeRedactions,
	] = await Promise.all([
		db.prepare("SELECT * FROM rooms WHERE id = ?").bind(roomId).first<RoomRow>(),
		db
			.prepare("SELECT * FROM participants WHERE room_id = ? ORDER BY created_at ASC")
			.bind(roomId)
			.all<ParticipantRow>(),
		db
			.prepare("SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 500")
			.bind(roomId)
			.all<MessageRow>(),
		db
			.prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY created_at ASC")
			.bind(roomId)
			.all<TaskRow>(),
		db
			.prepare("SELECT * FROM decisions WHERE room_id = ? ORDER BY created_at ASC")
			.bind(roomId)
			.all<DecisionRow>(),
		db
			.prepare("SELECT * FROM conductor_actions WHERE room_id = ? ORDER BY created_at ASC")
			.bind(roomId)
			.all<ActionRow>(),
		db
			.prepare(
				"SELECT identifier FROM room_runtime_redactions WHERE room_id = ? ORDER BY created_at ASC",
			)
			.bind(roomId)
			.all<{ identifier: string }>(),
	]);
	if (!roomResult) throw new HttpError(404, "room not found");
	return {
		room: roomFromRow(roomResult),
		participants: participants.results.map(participantFromRow),
		messages: messages.results.reverse().map(messageFromRow),
		tasks: tasks.results.map(taskFromRow),
		decisions: decisions.results.map(decisionFromRow),
		conductorActions: conductorActions.results.map(actionFromRow),
		runtimeRedactions: runtimeRedactions.results.map((row) => row.identifier),
	};
}

export async function addParticipant(
	db: D1Database,
	roomId: string,
	input: {
		displayName: string;
		kind: ParticipantKind;
		githubLogin?: string | null;
		requestId: string;
		maxAiSeats: number;
	},
): Promise<{ participant: Participant; participantToken: string }> {
	const existing = await db
		.prepare("SELECT * FROM participants WHERE room_id = ? AND join_request_id = ?")
		.bind(roomId, input.requestId)
		.first<ParticipantRow>();
	if (existing?.access_token) {
		return { participant: participantFromRow(existing), participantToken: existing.access_token };
	}
	const room = await db
		.prepare("SELECT slug, status FROM rooms WHERE id = ?")
		.bind(roomId)
		.first<{ slug: string; status: RoomStatus }>();
	if (!room) throw new HttpError(404, "room not found");
	if (["cleanup-planning", "cleanup-ending", "ended"].includes(room.status)) {
		throw new HttpError(409, "room is not accepting new seats");
	}
	if (input.kind !== "observer" && !roomAllowsPlanning(room.status)) {
		throw new HttpError(409, "only observers can join after launch");
	}
	const limit = input.kind === "observer" ? 24 : 5;
	const id = newId("person");
	const participantToken = newId("seat");
	const now = Date.now();
	const branch =
		input.kind === "observer" ? null : participantBranch(room.slug, input.displayName, id);
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT OR IGNORE INTO participants
        (id, room_id, kind, display_name, github_login, access_token, join_request_id, branch, state,
         joined_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'joined', ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM rooms
         WHERE id = ? AND ${
						input.kind === "observer"
							? "status NOT IN ('cleanup-planning', 'cleanup-ending', 'ended')"
							: "status IN ('setup', 'planning')"
					}
       )
       AND (
         SELECT COUNT(*) FROM participants
         WHERE room_id = ? ${input.kind === "observer" ? "" : "AND kind != 'observer'"}
       ) < ?
       AND (
         ? != 'ai' OR (
           SELECT COUNT(*) FROM participants WHERE room_id = ? AND kind = 'ai'
         ) < ?
       )`,
			)
			.bind(
				id,
				roomId,
				input.kind,
				input.displayName,
				input.githubLogin ?? null,
				participantToken,
				input.requestId,
				branch,
				now,
				now,
				now,
				roomId,
				roomId,
				limit,
				input.kind,
				roomId,
				input.maxAiSeats,
			),
	];
	if (input.kind !== "observer") {
		statements.push(
			db
				.prepare(
					`DELETE FROM tasks
           WHERE room_id = ?
             AND EXISTS (SELECT 1 FROM participants WHERE id = ? AND room_id = ?)`,
				)
				.bind(roomId, id, roomId),
			db
				.prepare(
					`UPDATE participants SET task_id = NULL, updated_at = ?
           WHERE room_id = ?
             AND EXISTS (SELECT 1 FROM participants WHERE id = ? AND room_id = ?)`,
				)
				.bind(now, roomId, id, roomId),
			db
				.prepare(
					`UPDATE rooms
           SET brief_json = json_set(brief_json, '$.planApproved', json('false')),
               brief_revision = brief_revision + 1, updated_at = ?
           WHERE id = ? AND status IN ('setup', 'planning')
             AND EXISTS (SELECT 1 FROM participants WHERE id = ? AND room_id = ?)`,
				)
				.bind(now, roomId, id, roomId),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO room_messages
          (id, room_id, author_kind, author_id, target_kind, body, created_at)
         SELECT ?, ?, 'system', 'system', 'system', ?, ?
         WHERE EXISTS (SELECT 1 FROM participants WHERE id = ? AND room_id = ?)`,
			)
			.bind(newId("msg"), roomId, `${input.displayName} joined the room.`, now, id, roomId),
	);
	const [result] = await db.batch(statements);
	if (result?.meta.changes !== 1) {
		const replay = await db
			.prepare("SELECT * FROM participants WHERE room_id = ? AND join_request_id = ?")
			.bind(roomId, input.requestId)
			.first<ParticipantRow>();
		if (replay?.access_token) {
			return { participant: participantFromRow(replay), participantToken: replay.access_token };
		}
		throw new HttpError(409, "room is no longer accepting this seat");
	}
	return {
		participant: participantFromRow(
			(await db
				.prepare("SELECT * FROM participants WHERE id = ?")
				.bind(id)
				.first<ParticipantRow>())!,
		),
		participantToken,
	};
}

export async function requireRoomParticipant(
	db: D1Database,
	roomId: string,
	participantToken: string,
	allowObserver = true,
): Promise<Participant> {
	const row = await db
		.prepare("SELECT * FROM participants WHERE access_token = ? AND room_id = ?")
		.bind(participantToken, roomId)
		.first<ParticipantRow>();
	if (!row) throw new HttpError(403, "participant is not in this room");
	const participant = participantFromRow(row);
	if (!allowObserver && participant.kind === "observer")
		throw new HttpError(403, "observer is read-only");
	return participant;
}

export async function addMessage(
	db: D1Database,
	roomId: string,
	input: Omit<RoomMessage, "id" | "roomId" | "createdAt">,
	expectedStatuses?: RoomStatus[],
	expectedBriefRevision?: number,
): Promise<RoomMessage | null> {
	if (expectedStatuses && !expectedStatuses.length) return null;
	if (expectedBriefRevision !== undefined && !expectedStatuses) return null;
	const message: RoomMessage = { ...input, id: newId("msg"), roomId, createdAt: Date.now() };
	const statusFence = expectedStatuses
		? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
	     WHERE EXISTS (
	       SELECT 1 FROM rooms
	       WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	         ${expectedBriefRevision === undefined ? "" : "AND brief_revision = ?"}
	     )`
		: "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
	const result = await db
		.prepare(
			`INSERT INTO room_messages
	        (id, room_id, author_kind, author_id, target_kind, target_id, body, reply_to_id, created_at)
	       ${statusFence}`,
		)
		.bind(
			message.id,
			roomId,
			message.authorKind,
			message.authorId,
			message.targetKind,
			message.targetId,
			message.body,
			message.replyToId,
			message.createdAt,
			...(expectedStatuses
				? [
						roomId,
						...expectedStatuses,
						...(expectedBriefRevision === undefined ? [] : [expectedBriefRevision]),
					]
				: []),
		)
		.run();
	return result.meta.changes === 1 ? message : null;
}

export async function replacePlan(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
	brief: RoomBrief,
	participants: Participant[],
	tasks: Array<Omit<Task, "roomId" | "createdAt" | "updatedAt">>,
): Promise<number | null> {
	const now = Date.now();
	const nextBriefRevision = newRevision();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE rooms
         SET brief_json = ?, brief_revision = ?, status = 'planning', updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning') AND brief_revision = ?`,
			)
			.bind(encodeJson(brief), nextBriefRevision, now, roomId, expectedBriefRevision),
		db
			.prepare(
				`DELETE FROM tasks
         WHERE room_id = ?
           AND EXISTS (
             SELECT 1 FROM rooms WHERE id = ? AND status = 'planning' AND brief_revision = ?
           )`,
			)
			.bind(roomId, roomId, nextBriefRevision),
		db
			.prepare(
				`UPDATE participants SET task_id = NULL, updated_at = ?
         WHERE room_id = ?
           AND EXISTS (
             SELECT 1 FROM rooms WHERE id = ? AND status = 'planning' AND brief_revision = ?
           )`,
			)
			.bind(now, roomId, roomId, nextBriefRevision),
	];
	for (const participant of participants) {
		if (participant.kind === "observer" || !participant.roleId) continue;
		statements.push(
			db
				.prepare(
					`UPDATE participants SET role_id = ?, updated_at = ?
           WHERE id = ? AND room_id = ?
             AND EXISTS (
               SELECT 1 FROM rooms WHERE id = ? AND status = 'planning' AND brief_revision = ?
             )`,
				)
				.bind(participant.roleId, now, participant.id, roomId, roomId, nextBriefRevision),
		);
	}
	for (const task of tasks) {
		const id = task.id;
		const owner = participantForTask(participants, task.ownerParticipantId);
		statements.push(
			db
				.prepare(
					`INSERT INTO tasks
            (id, room_id, title, description, owner_participant_id, state, depends_on_json,
             owns_paths_json, acceptance_criteria_json, branch, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM rooms WHERE id = ? AND status = 'planning' AND brief_revision = ?
           )`,
				)
				.bind(
					id,
					roomId,
					task.title,
					task.description,
					owner?.id ?? task.ownerParticipantId,
					task.state,
					encodeJson(task.dependsOn),
					encodeJson(task.ownsPaths),
					encodeJson(task.acceptanceCriteria),
					owner?.branch ?? task.branch,
					now,
					now,
					roomId,
					nextBriefRevision,
				),
		);
		if (owner) {
			statements.push(
				db
					.prepare(
						`UPDATE participants SET role_id = ?, task_id = ?, updated_at = ?
             WHERE id = ? AND room_id = ?
               AND EXISTS (
                 SELECT 1 FROM rooms WHERE id = ? AND status = 'planning' AND brief_revision = ?
               )`,
					)
					.bind(owner.roleId, id, now, owner.id, roomId, roomId, nextBriefRevision),
			);
		}
	}
	const [roomResult] = await db.batch(statements);
	return roomResult?.meta.changes === 1 ? nextBriefRevision : null;
}

export async function approveRoomPlan(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
): Promise<boolean> {
	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE rooms
	       SET status = 'provisioning', started_at = ?, ends_at = ? + duration_minutes * 60000,
	           brief_json = json_set(brief_json, '$.planApproved', json('true')), updated_at = ?
	       WHERE id = ? AND status = 'planning' AND brief_revision = ?
	         AND (SELECT COUNT(*) FROM tasks WHERE room_id = rooms.id) > 0
	         AND NOT EXISTS (
	           SELECT 1 FROM tasks WHERE room_id = rooms.id AND state = 'cut'
	         )
	         AND (SELECT COUNT(*) FROM tasks WHERE room_id = rooms.id) =
	             (SELECT COUNT(*) FROM participants WHERE room_id = rooms.id AND kind != 'observer')
	         AND NOT EXISTS (
	           SELECT 1
	           FROM participants AS participant
	           LEFT JOIN tasks AS task
	             ON task.id = participant.task_id
	             AND task.room_id = participant.room_id
	             AND task.owner_participant_id = participant.id
	           WHERE participant.room_id = rooms.id
	             AND participant.kind != 'observer'
	             AND (participant.role_id IS NULL OR participant.task_id IS NULL OR task.id IS NULL)
	         )
	         AND NOT EXISTS (
	           SELECT 1
	           FROM tasks AS task
	           LEFT JOIN participants AS participant
	             ON participant.id = task.owner_participant_id
	             AND participant.room_id = task.room_id
	             AND participant.kind != 'observer'
	           WHERE task.room_id = rooms.id AND participant.id IS NULL
	         )`,
		)
		.bind(now, now, now, roomId, expectedBriefRevision)
		.run();
	return result.meta.changes === 1;
}

export async function resetRoomProvisioning(
	db: D1Database,
	roomId: string,
	expectedStatuses: RoomStatus[],
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const now = Date.now();
	const [, , , roomResult] = await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
         SELECT id, crabfleet_root_session_id, ?
         FROM rooms
         WHERE id = ? AND crabfleet_root_session_id IS NOT NULL AND crabfleet_root_session_id != ''`,
			)
			.bind(now, roomId),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
         SELECT room_id, crabfleet_session_id, ?
         FROM participants
         WHERE room_id = ? AND crabfleet_session_id IS NOT NULL AND crabfleet_session_id != ''`,
			)
			.bind(now, roomId),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
         SELECT room_id, browser_url, ?
         FROM participants
         WHERE room_id = ? AND browser_url IS NOT NULL AND browser_url != ''`,
			)
			.bind(now, roomId),
		db
			.prepare(
				`UPDATE rooms
         SET status = 'planning', started_at = NULL, ends_at = NULL, crabfleet_root_session_id = NULL,
             brief_json = json_set(brief_json, '$.planApproved', json('false')),
             brief_revision = brief_revision + 1, updated_at = ?
         WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})`,
			)
			.bind(now, roomId, ...expectedStatuses),
		db
			.prepare(
				`UPDATE participants
         SET crabfleet_session_id = NULL, browser_url = NULL, runtime_summary = '', state = 'joined',
             updated_at = ?
         WHERE room_id = ?
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
			)
			.bind(now, roomId, roomId),
	]);
	return roomResult?.meta.changes === 1;
}

export async function recordProvisioningBinding(
	db: D1Database,
	roomId: string,
	rootSessionId: string,
	binding: {
		participantId: string;
		sessionId: string;
		browserUrl: string;
		summary: string;
		state: Participant["state"];
	},
): Promise<boolean> {
	const now = Date.now();
	const [roomResult, participantResult] = await db.batch([
		db
			.prepare(
				`UPDATE rooms
         SET crabfleet_root_session_id = COALESCE(crabfleet_root_session_id, ?), updated_at = ?
         WHERE id = ? AND status = 'provisioning'
           AND (crabfleet_root_session_id IS NULL OR crabfleet_root_session_id = ?)`,
			)
			.bind(rootSessionId, now, roomId, rootSessionId),
		db
			.prepare(
				`UPDATE participants
         SET crabfleet_session_id = ?, browser_url = ?, runtime_summary = ?, state = ?, updated_at = ?
         WHERE id = ? AND room_id = ?
           AND EXISTS (
             SELECT 1 FROM rooms
             WHERE id = ? AND status = 'provisioning' AND crabfleet_root_session_id = ?
           )`,
			)
			.bind(
				binding.sessionId,
				binding.browserUrl,
				binding.summary,
				binding.state,
				now,
				binding.participantId,
				roomId,
				roomId,
				rootSessionId,
			),
	]);
	return roomResult?.meta.changes === 1 && participantResult?.meta.changes === 1;
}

export async function claimStaleProvisioningCleanup(
	db: D1Database,
	roomId: string,
	staleBefore: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE rooms SET status = 'cleanup-planning', updated_at = ?
       WHERE id = ? AND status = 'provisioning' AND updated_at <= ?`,
		)
		.bind(Date.now(), roomId, staleBefore)
		.run();
	return result.meta.changes === 1;
}

export async function renewProvisioningLease(db: D1Database, roomId: string): Promise<boolean> {
	const result = await db
		.prepare("UPDATE rooms SET updated_at = ? WHERE id = ? AND status = 'provisioning'")
		.bind(Date.now(), roomId)
		.run();
	return result.meta.changes === 1;
}

export async function markRoomCleanup(
	db: D1Database,
	roomId: string,
	rootSessionId: string,
	status: "cleanup-planning" | "cleanup-ending",
	expectedStatuses: RoomStatus[],
	bindings: Array<{
		participantId: string;
		sessionId: string;
		browserUrl: string;
		summary: string;
		state: Participant["state"];
	}>,
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE rooms SET crabfleet_root_session_id = ?, status = ?, updated_at = ?
         WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})`,
			)
			.bind(rootSessionId, status, now, roomId, ...expectedStatuses),
	];
	for (const binding of bindings) {
		statements.push(
			db
				.prepare(
					`UPDATE participants
           SET crabfleet_session_id = ?, browser_url = ?, runtime_summary = ?, state = ?, updated_at = ?
           WHERE id = ? AND room_id = ?
             AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = ?)`,
				)
				.bind(
					binding.sessionId,
					binding.browserUrl,
					binding.summary,
					binding.state,
					now,
					binding.participantId,
					roomId,
					roomId,
					status,
				),
		);
	}
	const [roomResult] = await db.batch(statements);
	return roomResult?.meta.changes === 1;
}

export async function updateRoomRuntime(
	db: D1Database,
	roomId: string,
	rootSessionId: string | null,
	status: RoomStatus,
	expectedStatuses: RoomStatus[],
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE rooms SET crabfleet_root_session_id = ?, status = ?, updated_at = ?
       WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
         AND NOT EXISTS (
           SELECT 1 FROM room_runtime_leases
           WHERE room_id = rooms.id AND expires_at > ?
         )`,
		)
		.bind(rootSessionId, status, now, roomId, ...expectedStatuses, now)
		.run();
	return result.meta.changes === 1;
}

export async function claimRoomRuntimeLease(
	db: D1Database,
	roomId: string,
	kind: string,
	expectedStatuses: RoomStatus[],
	ttlMilliseconds: number,
): Promise<string | null> {
	if (!expectedStatuses.length) return null;
	const now = Date.now();
	const leaseId = newId("lease");
	const [, claim] = await db.batch([
		db
			.prepare("DELETE FROM room_runtime_leases WHERE room_id = ? AND expires_at <= ?")
			.bind(roomId, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_leases (room_id, lease_id, kind, expires_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
							.map(() => "?")
							.join(", ")})
         )`,
			)
			.bind(roomId, leaseId, kind, now + ttlMilliseconds, roomId, ...expectedStatuses),
	]);
	return claim?.meta.changes === 1 ? leaseId : null;
}

export async function releaseRoomRuntimeLease(
	db: D1Database,
	roomId: string,
	leaseId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM room_runtime_leases WHERE room_id = ? AND lease_id = ?")
		.bind(roomId, leaseId)
		.run();
}

export async function beginRoomCleanup(
	db: D1Database,
	roomId: string,
	rootSessionId: string | null,
	expectedStatuses: RoomStatus[],
	ttlMilliseconds: number,
): Promise<string | null> {
	if (!expectedStatuses.length) return null;
	const now = Date.now();
	const leaseId = newId("lease");
	const [, claim, transition] = await db.batch([
		db
			.prepare("DELETE FROM room_runtime_leases WHERE room_id = ? AND expires_at <= ?")
			.bind(roomId, now),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_leases (room_id, lease_id, kind, expires_at)
         SELECT ?, ?, 'room_end', ?
         WHERE EXISTS (
           SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
							.map(() => "?")
							.join(", ")})
         )`,
			)
			.bind(roomId, leaseId, now + ttlMilliseconds, roomId, ...expectedStatuses),
		db
			.prepare(
				`UPDATE rooms SET crabfleet_root_session_id = ?, status = 'cleanup-ending', updated_at = ?
       WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
         AND EXISTS (
           SELECT 1 FROM room_runtime_leases
           WHERE room_id = rooms.id AND lease_id = ? AND expires_at > ?
         )`,
			)
			.bind(rootSessionId, now, roomId, ...expectedStatuses, leaseId, now),
	]);
	if (claim?.meta.changes === 1 && transition?.meta.changes === 1) return leaseId;
	if (claim?.meta.changes === 1) await releaseRoomRuntimeLease(db, roomId, leaseId);
	return null;
}

export async function updateParticipantRuntime(
	db: D1Database,
	participantId: string,
	input: {
		sessionId?: string | null;
		browserUrl?: string | null;
		summary?: string;
		state?: Participant["state"];
	},
	fence?: { roomId: string; expectedStatuses: RoomStatus[] },
): Promise<boolean> {
	if (fence && !fence.expectedStatuses.length) return false;
	const roomFence = fence
		? `AND room_id = ?
	     AND EXISTS (
	       SELECT 1 FROM rooms WHERE id = ? AND status IN (${fence.expectedStatuses
						.map(() => "?")
						.join(", ")})
	     )`
		: "";
	const result = await db
		.prepare(
			`UPDATE participants
       SET crabfleet_session_id = COALESCE(?, crabfleet_session_id),
           browser_url = COALESCE(?, browser_url),
           runtime_summary = COALESCE(?, runtime_summary),
	           state = COALESCE(?, state),
	           updated_at = ?
	       WHERE id = ? ${roomFence}`,
		)
		.bind(
			input.sessionId ?? null,
			input.browserUrl ?? null,
			input.summary ?? null,
			input.state ?? null,
			Date.now(),
			participantId,
			...(fence ? [fence.roomId, fence.roomId, ...fence.expectedStatuses] : []),
		)
		.run();
	return result.meta.changes === 1;
}

export async function updateTaskState(
	db: D1Database,
	roomId: string,
	taskId: string,
	state: TaskState,
	expectedState: TaskState,
	expectedStatuses: RoomStatus[],
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const result = await db
		.prepare(
			`UPDATE tasks SET state = ?, updated_at = ?
       WHERE id = ? AND room_id = ? AND state = ?
         AND EXISTS (
           SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
							.map(() => "?")
							.join(", ")})
         )`,
		)
		.bind(state, Date.now(), taskId, roomId, expectedState, roomId, ...expectedStatuses)
		.run();
	return result.meta.changes === 1;
}

export async function updateTaskStateWithDecision(
	db: D1Database,
	roomId: string,
	taskId: string,
	state: TaskState,
	expectedState: TaskState,
	expectedStatuses: RoomStatus[],
	decision: Omit<Decision, "id" | "roomId" | "createdAt">,
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const decisionId = newId("decision");
	const now = Date.now();
	const [decisionResult, taskResult] = await db.batch([
		db
			.prepare(
				`INSERT INTO decisions
          (id, room_id, title, decision, reason, author_kind, author_id, affected_task_ids_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM tasks
           WHERE id = ? AND room_id = ? AND state = ?
             AND EXISTS (
               SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
									.map(() => "?")
									.join(", ")})
             )
         )`,
			)
			.bind(
				decisionId,
				roomId,
				decision.title,
				decision.decision,
				decision.reason,
				decision.authorKind,
				decision.authorId,
				encodeJson(decision.affectedTaskIds),
				now,
				taskId,
				roomId,
				expectedState,
				roomId,
				...expectedStatuses,
			),
		db
			.prepare(
				`UPDATE tasks SET state = ?, updated_at = ?
         WHERE id = ? AND room_id = ? AND state = ?
           AND EXISTS (SELECT 1 FROM decisions WHERE id = ? AND room_id = ?)`,
			)
			.bind(state, now, taskId, roomId, expectedState, decisionId, roomId),
	]);
	return decisionResult?.meta.changes === 1 && taskResult?.meta.changes === 1;
}

export async function addDecision(
	db: D1Database,
	roomId: string,
	input: Omit<Decision, "id" | "roomId" | "createdAt">,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO decisions
        (id, room_id, title, decision, reason, author_kind, author_id, affected_task_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId("decision"),
			roomId,
			input.title,
			input.decision,
			input.reason,
			input.authorKind,
			input.authorId,
			encodeJson(input.affectedTaskIds),
			Date.now(),
		)
		.run();
}

export async function addConductorAction(
	db: D1Database,
	roomId: string,
	input: Omit<ConductorAction, "id" | "roomId" | "createdAt">,
): Promise<string> {
	const id = newId("action");
	await db
		.prepare(
			`INSERT INTO conductor_actions
        (id, room_id, kind, target_ids_json, reason, evidence_refs_json, approval_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			roomId,
			input.kind,
			encodeJson(input.targetIds),
			input.reason,
			encodeJson(input.evidenceRefs),
			input.approvalState,
			Date.now(),
		)
		.run();
	return id;
}

export async function updateConductorActionApprovalState(
	db: D1Database,
	roomId: string,
	actionId: string,
	approvalState: ConductorAction["approvalState"],
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE conductor_actions
       SET approval_state = ?
       WHERE id = ? AND room_id = ? AND approval_state = 'requested'`,
		)
		.bind(approvalState, actionId, roomId)
		.run();
	return result.meta.changes === 1;
}

export async function claimConductorTurn(
	db: D1Database,
	roomId: string,
	actorParticipantId: string,
): Promise<boolean> {
	const now = Date.now();
	const result = await db
		.prepare(
			`INSERT INTO conductor_actions
        (id, room_id, kind, target_ids_json, reason, evidence_refs_json, approval_state, created_at)
       SELECT ?, ?, 'conductor_turn', ?, 'conductor turn started', '[]', 'not_required', ?
       WHERE EXISTS (
         SELECT 1 FROM rooms
         WHERE id = ? AND status NOT IN ('cleanup-planning', 'cleanup-ending', 'ended')
       )
       AND NOT EXISTS (
         SELECT 1 FROM conductor_actions
         WHERE room_id = ? AND kind = 'conductor_turn' AND created_at > ?
       )
       AND (
         SELECT COUNT(*) FROM conductor_actions
         WHERE room_id = ? AND kind = 'conductor_turn' AND created_at > ?
       ) < 12`,
		)
		.bind(
			newId("action"),
			roomId,
			encodeJson([actorParticipantId]),
			now,
			roomId,
			roomId,
			now - 60_000,
			roomId,
			now - 60 * 60 * 1000,
		)
		.run();
	return result.meta.changes === 1;
}

export async function endRoom(db: D1Database, roomId: string): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE rooms SET status = 'ended', updated_at = ? WHERE id = ? AND status = 'cleanup-ending'",
		)
		.bind(Date.now(), roomId)
		.run();
	return result.meta.changes === 1;
}

export function participantBranch(
	roomSlug: string,
	displayName: string,
	participantId: string,
): string {
	const prefix = `multicodex/${roomSlug}/`;
	const suffix = `-${slugify(participantId, "person")}`;
	const seat = slugify(displayName, "seat").slice(
		0,
		Math.max(1, 120 - prefix.length - suffix.length),
	);
	return `${prefix}${seat}${suffix}`;
}

export function participantForTask(
	participants: Participant[],
	ownerParticipantId: string | null,
): Participant | undefined {
	return participants.find((participant) => participant.id === ownerParticipantId);
}

function newRevision(): number {
	const words = crypto.getRandomValues(new Uint32Array(2));
	return ((words[0] ?? 0) & 0x1fffff) * 0x100000000 + (words[1] ?? 0);
}

function roomFromRow(row: RoomRow): Room {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		status: row.status,
		hostParticipantId: row.host_participant_id,
		repo: row.repo,
		baseBranch: row.base_branch,
		integrationBranch: row.integration_branch,
		crabfleetRootSessionId: row.crabfleet_root_session_id,
		brief: parseJson(row.brief_json, {}),
		briefRevision: row.brief_revision,
		durationMinutes: row.duration_minutes,
		startedAt: row.started_at,
		endsAt: row.ends_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function participantFromRow(row: ParticipantRow): Participant {
	return {
		id: row.id,
		roomId: row.room_id,
		kind: row.kind,
		displayName: row.display_name,
		githubLogin: row.github_login,
		roleId: row.role_id,
		taskId: row.task_id,
		crabfleetSessionId: row.crabfleet_session_id,
		browserUrl: row.browser_url,
		runtimeSummary: row.runtime_summary,
		branch: row.branch,
		state: row.state,
		joinedAt: row.joined_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function messageFromRow(row: MessageRow): RoomMessage {
	return {
		id: row.id,
		roomId: row.room_id,
		authorKind: row.author_kind,
		authorId: row.author_id,
		targetKind: row.target_kind,
		targetId: row.target_id,
		body: row.body,
		replyToId: row.reply_to_id,
		createdAt: row.created_at,
	};
}

function taskFromRow(row: TaskRow): Task {
	return {
		id: row.id,
		roomId: row.room_id,
		title: row.title,
		description: row.description,
		ownerParticipantId: row.owner_participant_id,
		state: row.state,
		dependsOn: parseJson(row.depends_on_json, []),
		ownsPaths: parseJson(row.owns_paths_json, []),
		acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
		branch: row.branch,
		pullRequestUrl: row.pull_request_url,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decisionFromRow(row: DecisionRow): Decision {
	return {
		id: row.id,
		roomId: row.room_id,
		title: row.title,
		decision: row.decision,
		reason: row.reason,
		authorKind: row.author_kind,
		authorId: row.author_id,
		affectedTaskIds: parseJson(row.affected_task_ids_json, []),
		createdAt: row.created_at,
	};
}

function actionFromRow(row: ActionRow): ConductorAction {
	return {
		id: row.id,
		roomId: row.room_id,
		kind: row.kind,
		targetIds: parseJson(row.target_ids_json, []),
		reason: row.reason,
		evidenceRefs: parseJson(row.evidence_refs_json, []),
		approvalState: row.approval_state,
		createdAt: row.created_at,
	};
}
