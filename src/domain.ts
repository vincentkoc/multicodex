export type RoomStatus =
	| "setup"
	| "planning"
	| "provisioning"
	| "building"
	| "integrating"
	| "presenting"
	| "cleanup-planning"
	| "cleanup-ending"
	| "ended";

export type ParticipantKind = "human" | "ai" | "observer";
export type ParticipantState =
	| "invited"
	| "joined"
	| "ready"
	| "working"
	| "blocked"
	| "done"
	| "left";
export type TaskState = "planned" | "ready" | "active" | "blocked" | "review" | "done" | "cut";
export type MessageTargetKind = "room" | "conductor" | "participant" | "task" | "system";

export type RoomBrief = {
	ideaId?: string;
	productGoal?: string;
	demoMoment?: string;
	constraints?: string[];
	acceptanceCriteria?: string[];
	planApproved?: boolean;
};

export type Room = {
	id: string;
	slug: string;
	title: string;
	status: RoomStatus;
	hostParticipantId: string;
	repo: string;
	baseBranch: string;
	integrationBranch: string;
	crabfleetRootSessionId: string | null;
	brief: RoomBrief;
	briefRevision: number;
	durationMinutes: number;
	startedAt: number | null;
	endsAt: number | null;
	createdAt: number;
	updatedAt: number;
};

export type Participant = {
	id: string;
	roomId: string;
	kind: ParticipantKind;
	displayName: string;
	githubLogin: string | null;
	roleId: string | null;
	taskId: string | null;
	crabfleetSessionId: string | null;
	browserUrl: string | null;
	runtimeSummary: string;
	branch: string | null;
	state: ParticipantState;
	joinedAt: number | null;
	createdAt: number;
	updatedAt: number;
};

export type RoomMessage = {
	id: string;
	roomId: string;
	authorKind: "human" | "conductor" | "system";
	authorId: string;
	targetKind: MessageTargetKind;
	targetId: string | null;
	body: string;
	replyToId: string | null;
	createdAt: number;
};

export type Task = {
	id: string;
	roomId: string;
	title: string;
	description: string;
	ownerParticipantId: string | null;
	state: TaskState;
	dependsOn: string[];
	ownsPaths: string[];
	acceptanceCriteria: string[];
	branch: string | null;
	pullRequestUrl: string | null;
	createdAt: number;
	updatedAt: number;
};

export type Decision = {
	id: string;
	roomId: string;
	title: string;
	decision: string;
	reason: string;
	authorKind: "human" | "conductor";
	authorId: string;
	affectedTaskIds: string[];
	createdAt: number;
};

export type ConductorAction = {
	id: string;
	roomId: string;
	kind: string;
	targetIds: string[];
	reason: string;
	evidenceRefs: string[];
	approvalState: "not_required" | "requested" | "approved" | "denied" | "delivery_unknown";
	createdAt: number;
};

export type RoomSnapshot = {
	room: Room;
	participants: Participant[];
	messages: RoomMessage[];
	messageCount: number;
	tasks: Task[];
	decisions: Decision[];
	conductorActions: ConductorAction[];
	runtimeRedactions: string[];
};
