import path from "node:path";

import {
	createAcpRuntime,
	createAgentRegistry,
	createRuntimeStore,
	type AcpRuntime,
	type AcpRuntimeHandle,
} from "acpx/runtime";

import type { AlphaRoomSnapshot, LaneCommandKind } from "../../protocol/src/index.ts";
import type { LocalRoomStore } from "./local-room.ts";

type HostConductorCommand = {
	laneId: string;
	kind: LaneCommandKind;
	text: string;
};

type RoutedConductorCommand = {
	kind: LaneCommandKind;
	reroutedFromIdleSteer: boolean;
};

export class LocalConductor {
	private readonly store: LocalRoomStore;
	private readonly runtime: AcpRuntime;
	private handle: AcpRuntimeHandle | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(store: LocalRoomStore, input: { repo: string; stateDir: string }) {
		this.store = store;
		this.runtime = createAcpRuntime({
			cwd: input.repo,
			sessionStore: createRuntimeStore({ stateDir: path.join(input.stateDir, "acpx") }),
			agentRegistry: createAgentRegistry(),
			permissionMode: "deny-all",
			nonInteractivePermissions: "deny",
			timeoutMs: 180_000,
		});
	}

	async initialize(): Promise<void> {
		this.handle = await this.runtime.ensureSession({
			sessionKey: `multicodex:${this.store.snapshot().id}:conductor`,
			agent: "codex",
			mode: "persistent",
			sessionOptions: {
				systemPrompt: {
					append:
						"You are the conductor for a local-first MultiCodex room. Be concise. Keep orchestration visible. Never request or approve arbitrary shell access. Participants retain local authority.",
				},
			},
		});
		await this.store.addConductorMessage("system", "host-local ACPx conductor ready");
	}

	message(text: string, source: "host" | "participant" = "host"): Promise<void> {
		const command =
			source === "host" ? parseHostConductorCommand(text, this.store.snapshot()) : null;
		if (command) return this.command(command.laneId, command.kind, command.text);
		return this.enqueue(async () => {
			const response = await this.turn(
				`Room snapshot:\n${compactSnapshot(this.store.snapshot())}\n\n${source === "host" ? "Host" : "Participant"} message:\n${text}\n\nRespond to the room concisely.`,
			);
			await this.store.addConductorMessage("conductor", response || "acknowledged");
		});
	}

	steer(laneId: string, text: string): Promise<void> {
		return this.command(laneId, "steer_active_turn", text);
	}

	command(laneId: string, kind: LaneCommandKind, text: string): Promise<void> {
		return this.enqueue(async () => {
			const snapshot = this.store.snapshot();
			const lane = snapshot.lanes.find((candidate) => candidate.id === laneId);
			if (!lane) throw new Error("lane not found");
			const routed = routeConductorCommand(snapshot, laneId, kind);
			await this.store.queueCommand(laneId, routed.kind, text);
			const message = routed.reroutedFromIdleSteer
				? `${lane.displayName} was idle, so the conductor started a new turn instead of steering a missing one.`
				: `Conductor sent ${commandLabel(routed.kind)} to ${lane.displayName}.`;
			await this.store.addConductorMessage("conductor", message);
		});
	}

	private enqueue(run: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(run, run);
		return this.queue;
	}

	private async turn(text: string): Promise<string> {
		if (!this.handle) throw new Error("conductor is not initialized");
		const turn = this.runtime.startTurn({
			handle: this.handle,
			text,
			mode: "prompt",
			requestId: crypto.randomUUID(),
			timeoutMs: 180_000,
		});
		let output = "";
		for await (const event of turn.events) {
			if (event.type === "text_delta" && event.stream !== "thought") output += event.text;
		}
		const result = await turn.result;
		if (result.status === "failed") throw new Error(result.error.message);
		return output.trim();
	}
}

export function routeConductorCommand(
	snapshot: AlphaRoomSnapshot,
	laneId: string,
	kind: LaneCommandKind,
): RoutedConductorCommand {
	const lane = snapshot.lanes.find((candidate) => candidate.id === laneId);
	if (!lane) throw new Error("lane not found");
	if (kind === "steer_active_turn" && !lane.currentTurnId) {
		return { kind: "start_followup", reroutedFromIdleSteer: true };
	}
	return { kind, reroutedFromIdleSteer: false };
}

function parseHostConductorCommand(
	text: string,
	snapshot: AlphaRoomSnapshot,
): HostConductorCommand | null {
	const match = text.trim().match(/^\/(start|steer|suggest|status|interrupt)\s+(.+)$/i);
	if (!match) return null;
	const [, verb, rest] = match;
	const kind = commandKindForVerb(verb!);
	const lane = findNamedLane(rest!, snapshot);
	if (!lane) return null;
	const message = rest!.slice(lane.displayName.length).trim();
	if (!message && kind !== "request_interrupt") return null;
	return {
		laneId: lane.id,
		kind,
		text: message || "interrupt requested by host",
	};
}

function findNamedLane(text: string, snapshot: AlphaRoomSnapshot) {
	const normalized = text.toLocaleLowerCase();
	return snapshot.lanes
		.filter((lane) => !lane.removedAt)
		.sort((left, right) => right.displayName.length - left.displayName.length)
		.find(
			(lane) =>
				normalized === lane.displayName.toLocaleLowerCase() ||
				normalized.startsWith(`${lane.displayName.toLocaleLowerCase()} `),
		);
}

function commandKindForVerb(verb: string): LaneCommandKind {
	switch (verb.toLocaleLowerCase()) {
		case "start":
			return "start_followup";
		case "steer":
			return "steer_active_turn";
		case "suggest":
			return "suggest";
		case "status":
			return "request_status";
		case "interrupt":
			return "request_interrupt";
		default:
			throw new Error("unsupported conductor command");
	}
}

function commandLabel(kind: LaneCommandKind): string {
	const labels: Record<LaneCommandKind, string> = {
		suggest: "a suggestion",
		request_status: "a status request",
		start_followup: "a follow-up turn",
		steer_active_turn: "a steer instruction",
		request_interrupt: "an interrupt request",
	};
	return labels[kind];
}

function compactSnapshot(snapshot: AlphaRoomSnapshot): string {
	return JSON.stringify({
		room: { id: snapshot.id, title: snapshot.title, repo: snapshot.repo },
		lanes: snapshot.lanes.map((lane) => ({
			id: lane.id,
			name: lane.displayName,
			policy: lane.policy,
			connected: lane.connected,
			status: lane.status,
			activeTurn: lane.currentTurnId,
			removed: Boolean(lane.removedAt),
		})),
		recentEvents: snapshot.events.slice(-12).map((event) => ({
			laneId: event.laneId,
			kind: event.kind,
			summary: event.summary,
		})),
	});
}
