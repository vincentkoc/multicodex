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
	root_provisioning_attempted_at: number | null;
	root_provisioning_request_json: string | null;
	creation_request_id: string | null;
	builder_invite_token: string | null;
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

type ParticipantJoinInput = {
	displayName: string;
	kind: ParticipantKind;
	githubLogin?: string | null;
	requestId: string;
	maxAiSeats: number;
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

type SnapshotAggregateRow = RoomRow & {
	participants_json: string;
	message_count: number | string;
	tasks_json: string;
	decisions_json: string;
	conductor_actions_json: string;
	runtime_redactions_json: string;
};

type RuntimeRedactionRow = {
	identifier: string;
	created_at: number;
};

export async function reserveRoomCreation(
	db: D1Database,
	requestId: string,
	activeRoomLimit: number,
	expiresAt: number,
): Promise<boolean> {
	const now = Date.now();
	const [, reservationResult] = await db.batch([
		db.prepare("DELETE FROM room_creation_reservations WHERE expires_at <= ?").bind(now),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_creation_reservations (request_id, expires_at, created_at)
         SELECT ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM rooms WHERE status != 'ended'
         ) + (
           SELECT COUNT(*) FROM room_creation_reservations WHERE expires_at > ?
         ) < ?`,
			)
			.bind(requestId, expiresAt, now, now, activeRoomLimit),
	]);
	if (reservationResult?.meta.changes === 1) return true;
	const existing = await db
		.prepare(
			"SELECT 1 AS found FROM room_creation_reservations WHERE request_id = ? AND expires_at > ?",
		)
		.bind(requestId, now)
		.first<{ found: number }>();
	return existing?.found === 1;
}

export async function releaseRoomCreationReservation(
	db: D1Database,
	requestId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM room_creation_reservations WHERE request_id = ?")
		.bind(requestId)
		.run();
}

export async function createRoom(
	db: D1Database,
	input: {
		title: string;
		hostName: string;
		repo: string;
		baseBranch: string;
		durationMinutes: number;
		activeRoomLimit: number;
		requestId: string;
	},
): Promise<{
	snapshot: RoomSnapshot;
	participantToken: string;
	builderInviteToken: string | null;
}> {
	const replay = await replayCreatedRoom(db, input.requestId);
	if (replay) return replay;
	const now = Date.now();
	const roomId = newId("room");
	const hostId = newId("person");
	const participantToken = newId("seat");
	const builderInviteToken = newId("invite");
	const roomSuffix = roomId
		.replace(/^room_/, "")
		.replaceAll("-", "")
		.slice(0, 20);
	const slug = `${slugify(input.title).slice(0, 40)}-${roomSuffix}`;
	const integrationBranch = `multicodex/${slug}/integration`;
	const [roomResult] = await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO rooms
          (id, slug, title, status, host_participant_id, repo, base_branch, integration_branch,
           creation_request_id, builder_invite_token, duration_minutes, created_at, updated_at)
         SELECT ?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?, ?
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
				builderInviteToken,
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
	return { snapshot: await readRoomSnapshot(db, roomId), participantToken, builderInviteToken };
}

export async function replayCreatedRoom(
	db: D1Database,
	requestId: string,
): Promise<{
	snapshot: RoomSnapshot;
	participantToken: string;
	builderInviteToken: string | null;
} | null> {
	const room = await db
		.prepare(
			"SELECT id, host_participant_id, builder_invite_token FROM rooms WHERE creation_request_id = ?",
		)
		.bind(requestId)
		.first<{ id: string; host_participant_id: string; builder_invite_token: string | null }>();
	if (!room) return null;
	const host = await db
		.prepare("SELECT access_token FROM participants WHERE id = ? AND room_id = ?")
		.bind(room.host_participant_id, room.id)
		.first<{ access_token: string | null }>();
	if (!host?.access_token) throw new HttpError(409, "room creation is incomplete");
	return {
		snapshot: await readRoomSnapshot(db, room.id),
		participantToken: host.access_token,
		builderInviteToken: room.builder_invite_token,
	};
}

export async function roomBuilderInviteAuthorized(
	db: D1Database,
	roomId: string,
	inviteToken: string,
): Promise<boolean> {
	if (!inviteToken) return false;
	const room = await db
		.prepare("SELECT id FROM rooms WHERE id = ? AND builder_invite_token = ?")
		.bind(roomId, inviteToken)
		.first<{ id: string }>();
	return Boolean(room);
}

export async function roomExists(db: D1Database, roomId: string): Promise<boolean> {
	const room = await db
		.prepare("SELECT 1 AS found FROM rooms WHERE id = ?")
		.bind(roomId)
		.first<{ found: number }>();
	return room?.found === 1;
}

export async function roomMessageExists(
	db: D1Database,
	roomId: string,
	messageId: string,
): Promise<boolean> {
	const message = await db
		.prepare("SELECT 1 AS found FROM room_messages WHERE id = ? AND room_id = ?")
		.bind(messageId, roomId)
		.first<{ found: number }>();
	return message?.found === 1;
}

export async function readRoomSnapshot(db: D1Database, roomId: string): Promise<RoomSnapshot> {
	const [snapshot, messages] = await db.batch([
		db
			.prepare(
				`SELECT rooms.*,
					COALESCE((
						SELECT json_group_array(json_object(
							'id', id, 'room_id', room_id, 'kind', kind, 'display_name', display_name,
							'github_login', github_login, 'role_id', role_id, 'task_id', task_id,
							'crabfleet_session_id', crabfleet_session_id, 'browser_url', browser_url,
							'runtime_summary', runtime_summary, 'branch', branch, 'state', state,
							'joined_at', joined_at, 'created_at', created_at, 'updated_at', updated_at
						))
						FROM participants WHERE room_id = rooms.id
					), '[]') AS participants_json,
					(SELECT COUNT(*) FROM room_messages WHERE room_id = rooms.id) AS message_count,
					COALESCE((
						SELECT json_group_array(json_object(
							'id', id, 'room_id', room_id, 'title', title, 'description', description,
							'owner_participant_id', owner_participant_id, 'state', state,
							'depends_on_json', depends_on_json, 'owns_paths_json', owns_paths_json,
							'acceptance_criteria_json', acceptance_criteria_json, 'branch', branch,
							'pull_request_url', pull_request_url, 'created_at', created_at,
							'updated_at', updated_at
						))
						FROM tasks WHERE room_id = rooms.id
					), '[]') AS tasks_json,
					COALESCE((
						SELECT json_group_array(json_object(
							'id', id, 'room_id', room_id, 'title', title, 'decision', decision,
							'reason', reason, 'author_kind', author_kind, 'author_id', author_id,
							'affected_task_ids_json', affected_task_ids_json, 'created_at', created_at
						))
						FROM decisions WHERE room_id = rooms.id
					), '[]') AS decisions_json,
					COALESCE((
						SELECT json_group_array(json_object(
							'id', id, 'room_id', room_id, 'kind', kind,
							'target_ids_json', target_ids_json, 'reason', reason,
							'evidence_refs_json', evidence_refs_json, 'approval_state', approval_state,
							'created_at', created_at
						))
						FROM conductor_actions WHERE room_id = rooms.id
					), '[]') AS conductor_actions_json,
					COALESCE((
						SELECT json_group_array(json_object(
							'identifier', identifier, 'created_at', created_at
						))
						FROM room_runtime_redactions WHERE room_id = rooms.id
					), '[]') AS runtime_redactions_json
				FROM rooms WHERE id = ?`,
			)
			.bind(roomId),
		db
			.prepare(
				"SELECT * FROM room_messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 500",
			)
			.bind(roomId),
	]);
	const roomResult = snapshot?.results[0] as SnapshotAggregateRow | undefined;
	if (!roomResult) throw new HttpError(404, "room not found");
	const participantRows = parseJson<ParticipantRow[]>(roomResult.participants_json, []).sort(
		(a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
	);
	const messageRows = (messages?.results ?? []) as MessageRow[];
	const taskRows = parseJson<TaskRow[]>(roomResult.tasks_json, []).sort(
		(a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
	);
	const decisionRows = parseJson<DecisionRow[]>(roomResult.decisions_json, []).sort(
		(a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
	);
	const actionRows = parseJson<ActionRow[]>(roomResult.conductor_actions_json, []).sort(
		(a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
	);
	const redactionRows = parseJson<RuntimeRedactionRow[]>(
		roomResult.runtime_redactions_json,
		[],
	).sort((a, b) => a.created_at - b.created_at || a.identifier.localeCompare(b.identifier));
	return {
		room: roomFromRow(roomResult),
		participants: participantRows.map(participantFromRow),
		messages: messageRows.reverse().map(messageFromRow),
		messageCount: Number(roomResult.message_count ?? messageRows.length),
		tasks: taskRows.map(taskFromRow),
		decisions: decisionRows.map(decisionFromRow),
		conductorActions: actionRows.map(actionFromRow),
		runtimeRedactions: redactionRows.map((row) => row.identifier),
	};
}

export async function readRoomMessagesPage(
	db: D1Database,
	roomId: string,
	before: { createdAt: number; id: string } | null,
	limit = 100,
): Promise<RoomMessage[]> {
	const boundedLimit = Math.max(1, Math.min(100, limit));
	const result = before
		? await db
				.prepare(
					`SELECT * FROM room_messages
           WHERE room_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
				)
				.bind(roomId, before.createdAt, before.createdAt, before.id, boundedLimit)
				.all<MessageRow>()
		: await db
				.prepare(
					`SELECT * FROM room_messages
           WHERE room_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
				)
				.bind(roomId, boundedLimit)
				.all<MessageRow>();
	return result.results.reverse().map(messageFromRow);
}

export async function addParticipant(
	db: D1Database,
	roomId: string,
	input: ParticipantJoinInput,
): Promise<{ participant: Participant; participantToken: string }> {
	const existing = await db
		.prepare("SELECT * FROM participants WHERE room_id = ? AND join_request_id = ?")
		.bind(roomId, input.requestId)
		.first<ParticipantRow>();
	const existingReplay = participantReplay(existing, input);
	if (existingReplay) return existingReplay;
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
		db
			.prepare(
				`UPDATE rooms SET updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning')
           AND EXISTS (SELECT 1 FROM participants WHERE id = ? AND room_id = ?)`,
			)
			.bind(now, roomId, id, roomId),
	);
	const [result] = await db.batch(statements);
	if (result?.meta.changes !== 1) {
		const replay = await db
			.prepare("SELECT * FROM participants WHERE room_id = ? AND join_request_id = ?")
			.bind(roomId, input.requestId)
			.first<ParticipantRow>();
		const insertedReplay = participantReplay(replay, input);
		if (insertedReplay) return insertedReplay;
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
	const [result] = await db.batch([
		db
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
			),
		db
			.prepare(
				`UPDATE rooms SET updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning')
           AND EXISTS (SELECT 1 FROM room_messages WHERE id = ? AND room_id = ?)`,
			)
			.bind(message.createdAt, roomId, message.id, roomId),
	]);
	return result?.meta.changes === 1 ? message : null;
}

export async function consumeRoomMessageBudget(
	db: D1Database,
	roomId: string,
	participantId: string,
	now: number,
	maxMessages: number,
	windowMilliseconds: number,
): Promise<boolean> {
	const staleBefore = now - windowMilliseconds;
	const result = await db
		.prepare(
			`INSERT INTO room_message_budgets
         (room_id, participant_id, window_started_at, message_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(room_id, participant_id) DO UPDATE SET
         window_started_at = CASE
           WHEN room_message_budgets.window_started_at <= ? THEN excluded.window_started_at
           ELSE room_message_budgets.window_started_at
         END,
         message_count = CASE
           WHEN room_message_budgets.window_started_at <= ? THEN 1
           ELSE room_message_budgets.message_count + 1
         END
       WHERE room_message_budgets.window_started_at <= ?
          OR room_message_budgets.message_count < ?
       RETURNING message_count`,
		)
		.bind(roomId, participantId, now, staleBefore, staleBefore, staleBefore, maxMessages)
		.first<{ message_count: number }>();
	return result !== null;
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
	       SET status = 'provisioning', started_at = NULL, ends_at = NULL,
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
		.bind(now, roomId, expectedBriefRevision)
		.run();
	return result.meta.changes === 1;
}

export async function resetRoomProvisioning(
	db: D1Database,
	roomId: string,
	expectedStatuses: RoomStatus[],
	expectedBriefRevision: number,
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const now = Date.now();
	const nextBriefRevision = newRevision();
	const [, , , roomResult] = await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
	         SELECT id, crabfleet_root_session_id, ?
	         FROM rooms
	         WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	           AND brief_revision = ?
	           AND crabfleet_root_session_id IS NOT NULL AND crabfleet_root_session_id != ''`,
			)
			.bind(now, roomId, ...expectedStatuses, expectedBriefRevision),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
	         SELECT room_id, crabfleet_session_id, ?
	         FROM participants
	         WHERE room_id = ? AND crabfleet_session_id IS NOT NULL AND crabfleet_session_id != ''
	           AND EXISTS (
	             SELECT 1 FROM rooms
	             WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	               AND brief_revision = ?
	           )`,
			)
			.bind(now, roomId, roomId, ...expectedStatuses, expectedBriefRevision),
		db
			.prepare(
				`INSERT OR IGNORE INTO room_runtime_redactions (room_id, identifier, created_at)
	         SELECT room_id, browser_url, ?
	         FROM participants
	         WHERE room_id = ? AND browser_url IS NOT NULL AND browser_url != ''
	           AND EXISTS (
	             SELECT 1 FROM rooms
	             WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	               AND brief_revision = ?
	           )`,
			)
			.bind(now, roomId, roomId, ...expectedStatuses, expectedBriefRevision),
		db
			.prepare(
				`UPDATE rooms
	         SET status = 'planning', started_at = NULL, ends_at = NULL, crabfleet_root_session_id = NULL,
	             root_provisioning_attempted_at = NULL, root_provisioning_request_json = NULL,
	             brief_json = json_set(brief_json, '$.planApproved', json('false')),
	             brief_revision = ?, updated_at = ?
	         WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	           AND brief_revision = ?`,
			)
			.bind(nextBriefRevision, now, roomId, ...expectedStatuses, expectedBriefRevision),
		db
			.prepare(
				`UPDATE participants
	         SET crabfleet_session_id = NULL, browser_url = NULL, runtime_summary = '', state = 'joined',
	             updated_at = ?
	         WHERE room_id = ?
	           AND EXISTS (
	             SELECT 1 FROM rooms
	             WHERE id = ? AND status = 'planning' AND brief_revision = ?
	           )`,
			)
			.bind(now, roomId, roomId, nextBriefRevision),
	]);
	return roomResult?.meta.changes === 1;
}

export async function recordProvisioningBinding(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
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
	         WHERE id = ? AND status = 'provisioning' AND brief_revision = ?
	           AND (crabfleet_root_session_id IS NULL OR crabfleet_root_session_id = ?)`,
			)
			.bind(rootSessionId, now, roomId, expectedBriefRevision, rootSessionId),
		db
			.prepare(
				`UPDATE participants
         SET crabfleet_session_id = ?, browser_url = ?, runtime_summary = ?, state = ?, updated_at = ?
         WHERE id = ? AND room_id = ?
           AND EXISTS (
	             SELECT 1 FROM rooms
	             WHERE id = ? AND status = 'provisioning' AND brief_revision = ?
	               AND crabfleet_root_session_id = ?
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
				expectedBriefRevision,
				rootSessionId,
			),
	]);
	return roomResult?.meta.changes === 1 && participantResult?.meta.changes === 1;
}

export async function refreshProvisioningBinding(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
	rootSessionId: string,
	binding: {
		participantId: string;
		sessionId: string;
		browserUrl: string;
		summary: string;
		state: Participant["state"];
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE participants
       SET crabfleet_session_id = ?, browser_url = ?, runtime_summary = ?, state = ?, updated_at = ?
       WHERE id = ? AND room_id = ?
         AND EXISTS (
           SELECT 1 FROM rooms
           WHERE id = ? AND status = 'provisioning' AND brief_revision = ?
             AND crabfleet_root_session_id = ?
         )`,
		)
		.bind(
			binding.sessionId,
			binding.browserUrl,
			binding.summary,
			binding.state,
			Date.now(),
			binding.participantId,
			roomId,
			roomId,
			expectedBriefRevision,
			rootSessionId,
		)
		.run();
	return result.meta.changes === 1;
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

export async function renewProvisioningLease(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			"UPDATE rooms SET updated_at = ? WHERE id = ? AND status = 'provisioning' AND brief_revision = ?",
		)
		.bind(Date.now(), roomId, expectedBriefRevision)
		.run();
	return result.meta.changes === 1;
}

export async function markRootProvisioningAttempt(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
	requestJson: string,
): Promise<boolean> {
	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE rooms
       SET root_provisioning_attempted_at = COALESCE(root_provisioning_attempted_at, ?),
           root_provisioning_request_json = COALESCE(root_provisioning_request_json, ?),
           updated_at = ?
	       WHERE id = ? AND status = 'provisioning' AND brief_revision = ?
	         AND (root_provisioning_request_json IS NULL OR root_provisioning_request_json = ?)`,
		)
		.bind(now, requestJson, now, roomId, expectedBriefRevision, requestJson)
		.run();
	return result.meta.changes === 1;
}

export async function roomRootProvisioningAttempted(
	db: D1Database,
	roomId: string,
): Promise<boolean> {
	const room = await db
		.prepare("SELECT root_provisioning_attempted_at FROM rooms WHERE id = ?")
		.bind(roomId)
		.first<{ root_provisioning_attempted_at: number | null }>();
	return room?.root_provisioning_attempted_at != null;
}

export async function readRoomRootProvisioningRequest(
	db: D1Database,
	roomId: string,
): Promise<string | null> {
	const room = await db
		.prepare("SELECT root_provisioning_request_json FROM rooms WHERE id = ?")
		.bind(roomId)
		.first<{ root_provisioning_request_json: string | null }>();
	return room?.root_provisioning_request_json ?? null;
}

export async function markRoomCleanup(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
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
	         WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
	           AND brief_revision = ?`,
			)
			.bind(rootSessionId, status, now, roomId, ...expectedStatuses, expectedBriefRevision),
	];
	for (const binding of bindings) {
		statements.push(
			db
				.prepare(
					`UPDATE participants
           SET crabfleet_session_id = ?, browser_url = ?, runtime_summary = ?, state = ?, updated_at = ?
           WHERE id = ? AND room_id = ?
	             AND EXISTS (
	               SELECT 1 FROM rooms WHERE id = ? AND status = ? AND brief_revision = ?
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
					status,
					expectedBriefRevision,
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

export async function completeRoomProvisioning(
	db: D1Database,
	roomId: string,
	expectedBriefRevision: number,
	rootSessionId: string,
): Promise<boolean> {
	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE rooms
       SET crabfleet_root_session_id = ?, status = 'building',
           started_at = ?, ends_at = ? + duration_minutes * 60000, updated_at = ?
       WHERE id = ? AND status = 'provisioning' AND brief_revision = ?
         AND NOT EXISTS (
           SELECT 1 FROM room_runtime_leases
           WHERE room_id = rooms.id AND expires_at > ?
         )`,
		)
		.bind(rootSessionId, now, now, now, roomId, expectedBriefRevision, now)
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
	const now = Date.now();
	const [taskResult] = await db.batch([
		db
			.prepare(
				`UPDATE tasks SET state = ?, updated_at = ?
	       WHERE id = ? AND room_id = ? AND state = ?
	         AND EXISTS (
	           SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
								.map(() => "?")
								.join(", ")})
	         )`,
			)
			.bind(state, now, taskId, roomId, expectedState, roomId, ...expectedStatuses),
		db
			.prepare(
				`UPDATE rooms SET updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning')
           AND EXISTS (
             SELECT 1 FROM tasks
             WHERE id = ? AND room_id = ? AND state = ? AND updated_at = ?
           )`,
			)
			.bind(now, roomId, taskId, roomId, state, now),
	]);
	return taskResult?.meta.changes === 1;
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
		db
			.prepare(
				`UPDATE rooms SET updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning')
           AND EXISTS (SELECT 1 FROM decisions WHERE id = ? AND room_id = ?)`,
			)
			.bind(now, roomId, decisionId, roomId),
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

export async function expireInactivePrelaunchRooms(
	db: D1Database,
	staleBefore: number,
	limit = 20,
): Promise<string[]> {
	const boundedLimit = Math.max(1, Math.min(100, limit));
	const candidates = await db
		.prepare(
			`SELECT id FROM rooms
       WHERE status IN ('setup', 'planning') AND updated_at <= ?
         AND crabfleet_root_session_id IS NULL
         AND root_provisioning_attempted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM participants
           WHERE participants.room_id = rooms.id AND crabfleet_session_id IS NOT NULL
         )
       ORDER BY updated_at ASC
       LIMIT ?`,
		)
		.bind(staleBefore, boundedLimit)
		.all<{ id: string }>();
	if (!candidates.results.length) return [];
	const now = Date.now();
	const results = await db.batch(
		candidates.results.map(({ id }) =>
			db
				.prepare(
					`UPDATE rooms SET status = 'ended', updated_at = ?
           WHERE id = ? AND status IN ('setup', 'planning') AND updated_at <= ?
             AND crabfleet_root_session_id IS NULL
             AND root_provisioning_attempted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM participants
               WHERE participants.room_id = rooms.id AND crabfleet_session_id IS NOT NULL
             )`,
				)
				.bind(now, id, staleBefore),
		),
	);
	return candidates.results
		.filter((_, index) => results[index]?.meta.changes === 1)
		.map(({ id }) => id);
}

export async function listRuntimeRoomIdsNeedingCleanup(
	db: D1Database,
	now: number,
	staleBefore: number,
	limit = 20,
): Promise<string[]> {
	const result = await db
		.prepare(
			`SELECT id FROM rooms
       WHERE status IN ('cleanup-planning', 'cleanup-ending')
          OR (status = 'provisioning' AND updated_at <= ?)
          OR (
            ends_at IS NOT NULL AND ends_at <= ?
            AND status IN ('building', 'integrating', 'presenting')
          )
       ORDER BY updated_at ASC
       LIMIT ?`,
		)
		.bind(staleBefore, now, Math.max(1, Math.min(100, limit)))
		.all<{ id: string }>();
	return result.results.map((row) => row.id);
}

export async function recordRoomCleanupAttempt(
	db: D1Database,
	roomId: string,
	attemptedAt: number,
): Promise<void> {
	await db
		.prepare(
			`UPDATE rooms SET updated_at = ?
       WHERE id = ?
         AND (
           status IN ('cleanup-planning', 'cleanup-ending', 'provisioning')
           OR (
             ends_at IS NOT NULL AND ends_at <= ?
             AND status IN ('building', 'integrating', 'presenting')
           )
         )`,
		)
		.bind(attemptedAt, roomId, attemptedAt)
		.run();
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

function participantReplay(
	row: ParticipantRow | null,
	input: ParticipantJoinInput,
): { participant: Participant; participantToken: string } | null {
	if (!row?.access_token) return null;
	if (
		row.kind !== input.kind ||
		row.display_name !== input.displayName ||
		row.github_login !== (input.githubLogin ?? null)
	) {
		throw new HttpError(409, "join request does not match the original seat");
	}
	return { participant: participantFromRow(row), participantToken: row.access_token };
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
