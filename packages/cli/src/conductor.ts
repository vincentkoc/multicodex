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

	message(text: string): Promise<void> {
		return this.enqueue(async () => {
			const response = await this.turn(
				`Room snapshot:\n${compactSnapshot(this.store.snapshot())}\n\nHost message:\n${text}\n\nRespond to the room concisely.`,
			);
			await this.store.addConductorMessage("conductor", response || "acknowledged");
		});
	}

	steer(laneId: string, text: string): Promise<void> {
		return this.command(laneId, "steer_active_turn", text);
	}

	command(laneId: string, kind: LaneCommandKind, text: string): Promise<void> {
		return this.enqueue(async () => {
			const response = await this.turn(
				`Room snapshot:\n${compactSnapshot(this.store.snapshot())}\n\nThe host asks you to deliver the visible ${kind} action to lane ${laneId}:\n${text}\n\nBriefly state why this action helps.`,
			);
			if (response) await this.store.addConductorMessage("conductor", response);
			await this.store.queueCommand(laneId, kind, text);
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
