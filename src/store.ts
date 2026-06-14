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
		durationMinutes: number;
		activeRoomLimit: number;
		activeUpdatedSince: number;
	},
): Promise<{ snapshot: RoomSnapshot; participantToken: string }> {
	const now = Date.now();
	const roomId = newId("room");
	const hostId = newId("person");
	const participantToken = newId("seat");
	const slug = `${slugify(input.title).slice(0, 40)}-${roomId.slice(-6)}`;
	const integrationBranch = `multicodex/${slug}/integration`;
	const [roomResult] = await db.batch([
		db
			.prepare(
				`INSERT INTO rooms
          (id, slug, title, status, host_participant_id, repo, base_branch, integration_branch,
           duration_minutes, created_at, updated_at)
         SELECT ?, ?, ?, 'setup', ?, ?, 'main', ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM rooms WHERE status != 'ended' AND updated_at >= ?
         ) < ?`,
			)
			.bind(
				roomId,
				slug,
				input.title,
				hostId,
				input.repo,
				integrationBranch,
				input.durationMinutes,
				now,
				now,
				input.activeUpdatedSince,
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
	if (roomResult?.meta.changes !== 1) throw new HttpError(429, "active room limit reached");
	return { snapshot: await readRoomSnapshot(db, roomId), participantToken };
}

export async function readRoomSnapshot(db: D1Database, roomId: string): Promise<RoomSnapshot> {
	const [roomResult, participants, messages, tasks, decisions, conductorActions] =
		await Promise.all([
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
		]);
	if (!roomResult) throw new HttpError(404, "room not found");
	return {
		room: roomFromRow(roomResult),
		participants: participants.results.map(participantFromRow),
		messages: messages.results.reverse().map(messageFromRow),
		tasks: tasks.results.map(taskFromRow),
		decisions: decisions.results.map(decisionFromRow),
		conductorActions: conductorActions.results.map(actionFromRow),
	};
}

export async function addParticipant(
	db: D1Database,
	roomId: string,
	input: { displayName: string; kind: ParticipantKind; githubLogin?: string | null },
): Promise<{ participant: Participant; participantToken: string }> {
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
				`INSERT INTO participants
        (id, room_id, kind, display_name, github_login, access_token, branch, state, joined_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'joined', ?, ?, ?
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
       ) < ?`,
			)
			.bind(
				id,
				roomId,
				input.kind,
				input.displayName,
				input.githubLogin ?? null,
				participantToken,
				branch,
				now,
				now,
				now,
				roomId,
				roomId,
				limit,
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
	const [result] = await db.batch(statements);
	if (result?.meta.changes !== 1) {
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
): Promise<RoomMessage | null> {
	if (expectedStatuses && !expectedStatuses.length) return null;
	const message: RoomMessage = { ...input, id: newId("msg"), roomId, createdAt: Date.now() };
	const statusFence = expectedStatuses
		? `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
	     WHERE EXISTS (
	       SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})
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
			...(expectedStatuses ? [roomId, ...expectedStatuses] : []),
		)
		.run();
	return result.meta.changes === 1 ? message : null;
}

export async function replacePlan(
	db: D1Database,
	roomId: string,
	brief: RoomBrief,
	participants: Participant[],
	tasks: Array<Omit<Task, "roomId" | "createdAt" | "updatedAt">>,
): Promise<boolean> {
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE rooms
         SET brief_json = ?, brief_revision = brief_revision + 1, status = 'planning', updated_at = ?
         WHERE id = ? AND status IN ('setup', 'planning')`,
			)
			.bind(encodeJson(brief), now, roomId),
		db
			.prepare(
				`DELETE FROM tasks
         WHERE room_id = ?
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
			)
			.bind(roomId, roomId),
		db
			.prepare(
				`UPDATE participants SET task_id = NULL, updated_at = ?
         WHERE room_id = ?
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
			)
			.bind(now, roomId, roomId),
	];
	for (const participant of participants) {
		if (participant.kind === "observer" || !participant.roleId) continue;
		statements.push(
			db
				.prepare(
					`UPDATE participants SET role_id = ?, updated_at = ?
           WHERE id = ? AND room_id = ?
             AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
				)
				.bind(participant.roleId, now, participant.id, roomId, roomId),
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
           WHERE EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
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
				),
		);
		if (owner) {
			statements.push(
				db
					.prepare(
						`UPDATE participants SET role_id = ?, task_id = ?, updated_at = ?
             WHERE id = ? AND room_id = ?
               AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'planning')`,
					)
					.bind(owner.roleId, id, now, owner.id, roomId, roomId),
			);
		}
	}
	const [roomResult] = await db.batch(statements);
	return roomResult?.meta.changes === 1;
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

export async function resetRoomProvisioning(db: D1Database, roomId: string): Promise<void> {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE rooms
         SET status = 'planning', started_at = NULL, ends_at = NULL, crabfleet_root_session_id = NULL,
             brief_json = json_set(brief_json, '$.planApproved', json('false')), updated_at = ?
         WHERE id = ? AND status IN ('provisioning', 'building', 'cleanup-planning')`,
			)
			.bind(now, roomId),
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
	const result = await db
		.prepare(
			`UPDATE rooms SET crabfleet_root_session_id = ?, status = ?, updated_at = ?
       WHERE id = ? AND status IN (${expectedStatuses.map(() => "?").join(", ")})`,
		)
		.bind(rootSessionId, status, Date.now(), roomId, ...expectedStatuses)
		.run();
	return result.meta.changes === 1;
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
	expectedStatuses: RoomStatus[],
): Promise<boolean> {
	if (!expectedStatuses.length) return false;
	const result = await db
		.prepare(
			`UPDATE tasks SET state = ?, updated_at = ?
       WHERE id = ? AND room_id = ?
         AND EXISTS (
           SELECT 1 FROM rooms WHERE id = ? AND status IN (${expectedStatuses
							.map(() => "?")
							.join(", ")})
         )`,
		)
		.bind(state, Date.now(), taskId, roomId, roomId, ...expectedStatuses)
		.run();
	return result.meta.changes === 1;
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
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO conductor_actions
        (id, room_id, kind, target_ids_json, reason, evidence_refs_json, approval_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId("action"),
			roomId,
			input.kind,
			encodeJson(input.targetIds),
			input.reason,
			encodeJson(input.evidenceRefs),
			input.approvalState,
			Date.now(),
		)
		.run();
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
