export const protocolVersion = 1;

export type LanePolicy = "observe" | "suggest" | "steer";

export type LaneEventKind =
	| "lane.connected"
	| "lane.disconnected"
	| "lane.thread_attached"
	| "lane.status"
	| "lane.removed"
	| "turn.started"
	| "turn.completed"
	| "turn.failed"
	| "user.message"
	| "agent.message"
	| "agent.plan"
	| "command.started"
	| "command.completed"
	| "files.changed"
	| "approval.requested"
	| "command.result";

export type LaneCommandKind =
	| "suggest"
	| "start_followup"
	| "steer_active_turn"
	| "request_status"
	| "request_interrupt";

export type LaneEvent = {
	version: typeof protocolVersion;
	id: string;
	roomId: string;
	laneId: string;
	sequence: number;
	at: number;
	kind: LaneEventKind;
	summary: string;
	payload?: Record<string, unknown>;
};

export type LaneCommand = {
	version: typeof protocolVersion;
	id: string;
	roomId: string;
	laneId: string;
	sequence: number;
	at: number;
	expiresAt: number;
	kind: LaneCommandKind;
	text: string;
	source: "conductor";
	requiredPolicy: LanePolicy;
};

export type LaneCommandResult =
	| "accepted"
	| "rejected_policy"
	| "rejected_local_user"
	| "expired"
	| "unsupported"
	| "duplicate"
	| "failed";

export type AlphaLane = {
	id: string;
	displayName: string;
	repo: string;
	policy: LanePolicy;
	terminalMirror: boolean;
	terminalColumns: number | null;
	terminalRows: number | null;
	connected: boolean;
	threadId: string | null;
	currentTurnId: string | null;
	lastEventSequence: number;
	lastCommandSequence: number;
	status: string;
	joinedAt: number;
	updatedAt: number;
	removedAt: number | null;
};

export type ConductorMessage = {
	id: string;
	author: "host" | "conductor" | "system" | "participant";
	authorName?: string;
	laneId?: string;
	body: string;
	at: number;
};

export type AlphaRoomSnapshot = {
	version: typeof protocolVersion;
	id: string;
	title: string;
	repo: string;
	createdAt: number;
	lanes: AlphaLane[];
	events: LaneEvent[];
	conductorMessages: ConductorMessage[];
};

export function requiredPolicyForCommand(kind: LaneCommandKind): LanePolicy {
	switch (kind) {
		case "suggest":
		case "request_status":
			return "suggest";
		case "start_followup":
		case "steer_active_turn":
		case "request_interrupt":
			return "steer";
	}
}

export function policyAllows(policy: LanePolicy, command: LaneCommandKind): boolean {
	const rank: Record<LanePolicy, number> = { observe: 0, suggest: 1, steer: 2 };
	return rank[policy] >= rank[requiredPolicyForCommand(command)];
}

export function createLaneEvent(
	input: Omit<LaneEvent, "version" | "id" | "at"> & { id?: string; at?: number },
): LaneEvent {
	return {
		...input,
		version: protocolVersion,
		id: input.id ?? crypto.randomUUID(),
		at: input.at ?? Date.now(),
	};
}
