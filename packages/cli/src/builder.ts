import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
	type AlphaLane,
	createLaneEvent,
	type LaneCommand,
	type LaneCommandResult,
	type LaneEvent,
	type LaneEventKind,
	type LanePolicy,
	policyAllows,
} from "../../protocol/src/index.ts";
import {
	type AppServerNotification,
	CodexAppServerClient,
	startCodexAppServer,
} from "./app-server.ts";
import {
	BuilderStateStore,
	normalizeServer,
	parseRoomEndpoint,
	type PersistedBuilderState,
} from "./builder-state.ts";

type JoinResponse = {
	room: { id: string };
	lane: AlphaLane;
	token: string;
};

export class BuilderBridge {
	private readonly input: {
		server: string;
		repo: string;
		displayName: string;
		policy: LanePolicy;
		codexPath: string;
		noTui: boolean;
		prompt?: string;
		fresh: boolean;
		statePath?: string;
	};
	private readonly stateStore: BuilderStateStore;
	private readonly inviteToken?: string;
	private roomId = "";
	private laneId = "";
	private token = "";
	private sequence = 0;
	private commandSequence = 0;
	private threadId = "";
	private activeTurnId: string | null = null;
	private spool: LaneEvent[] = [];
	private client: CodexAppServerClient | null = null;
	private appServerStop: (() => void) | null = null;
	private tuiChild: ChildProcess | null = null;
	private stopping = false;
	private waitingForTuiThread = false;
	private pendingTuiThreadId: string | null = null;
	private attachingTuiThread = false;
	private persistenceError: Error | null = null;
	private readonly activity = new ActivityDeltaBuffer();
	private readonly stopped: Promise<void>;
	private resolveStopped: (() => void) | null = null;

	constructor(input: BuilderBridge["input"]) {
		const endpoint = parseRoomEndpoint(input.server);
		this.input = {
			...input,
			server: endpoint.server,
			repo: path.resolve(input.repo),
		};
		this.inviteToken = endpoint.inviteToken;
		this.stopped = new Promise<void>((resolve) => {
			this.resolveStopped = resolve;
		});
		this.stateStore = new BuilderStateStore({
			repo: this.input.repo,
			server: this.input.server,
			displayName: this.input.displayName,
			statePath: this.input.statePath,
		});
	}

	async run(): Promise<void> {
		await this.joinOrResume();
		const appServer = await startCodexAppServer(this.input.codexPath);
		this.appServerStop = appServer.stop;
		this.client = new CodexAppServerClient(appServer.endpoint);
		await this.client.connect();
		this.client.onNotification((notification) => this.receiveNotification(notification));
		this.emit("lane.connected", `local bridge connected (${this.input.policy})`, {
			endpoint: "loopback",
		});
		if (this.threadId) {
			try {
				await this.client.resumeThread(this.threadId);
				this.emit("lane.thread_attached", "persisted Codex thread resumed", {
					threadId: this.threadId,
					codexEndpoint: appServer.endpoint,
				});
			} catch {
				this.threadId = "";
				this.emit("lane.status", "persisted Codex thread unavailable; starting a new thread");
			}
		}
		if (!this.threadId && this.input.noTui) {
			this.threadId = await this.client.startThread(this.input.repo);
			this.emit("lane.thread_attached", "headless Codex thread attached", {
				threadId: this.threadId,
				codexEndpoint: appServer.endpoint,
			});
		} else if (!this.threadId) {
			this.waitingForTuiThread = true;
		}
		await this.flush();

		const poll = setInterval(() => void this.tick(), 700);
		try {
			if (this.input.noTui && this.input.prompt) {
				await this.client.startTurn(this.threadId, this.input.prompt);
			}
			if (this.input.noTui) await this.stopped;
			else await this.runTui(appServer.endpoint);
		} finally {
			clearInterval(poll);
			this.flushActivity();
			this.emit("lane.disconnected", "local Codex TUI disconnected");
			await this.flush().catch(() => undefined);
			this.stop();
		}
	}

	stop(): void {
		if (this.stopping) return;
		this.stopping = true;
		this.resolveStopped?.();
		this.resolveStopped = null;
		this.client?.close();
		this.appServerStop?.();
		if (this.tuiChild && !this.tuiChild.killed) this.tuiChild.kill("SIGTERM");
	}

	private async joinOrResume(): Promise<void> {
		if (this.input.fresh) await this.stateStore.clear();
		const restored = this.input.fresh ? null : await this.stateStore.load();
		if (restored && this.matches(restored)) {
			this.restore(restored);
			const response = await fetch(
				new URL(`/api/lanes/${encodeURIComponent(this.laneId)}/resume`, this.input.server),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${this.token}`,
					},
					body: JSON.stringify({
						displayName: this.input.displayName,
						repo: this.input.repo,
						policy: this.input.policy,
					}),
				},
			);
			const payload = (await response.json()) as JoinResponse & { error?: string };
			if (response.ok) {
				this.roomId = payload.room.id;
				this.sequence = Math.max(this.sequence, payload.lane.lastEventSequence);
				this.spool = this.spool.filter(
					(event) =>
						event.roomId === this.roomId &&
						event.laneId === this.laneId &&
						event.sequence > payload.lane.lastEventSequence,
				);
				await this.persistState();
				return;
			}
			if (![401, 404, 410].includes(response.status)) {
				throw new Error(payload.error ?? `lane resume failed (${response.status})`);
			}
			await this.stateStore.clear();
			this.reset();
		}

		const response = await fetch(new URL("/api/join", this.input.server), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.inviteToken ? { authorization: `Bearer ${this.inviteToken}` } : {}),
			},
			body: JSON.stringify({
				displayName: this.input.displayName,
				repo: this.input.repo,
				policy: this.input.policy,
			}),
		});
		const payload = (await response.json()) as JoinResponse & { error?: string };
		if (!response.ok) throw new Error(payload.error ?? `join failed (${response.status})`);
		this.roomId = payload.room.id;
		this.laneId = payload.lane.id;
		this.token = payload.token;
		await this.persistState();
	}

	private async tick(): Promise<void> {
		if (this.stopping) return;
		await this.attachPendingTuiThread().catch(() => undefined);
		await this.flush().catch(() => undefined);
		await this.pollCommands().catch(() => undefined);
	}

	private emit(kind: LaneEventKind, summary: string, payload?: Record<string, unknown>): void {
		this.sequence += 1;
		this.spool.push(
			createLaneEvent({
				roomId: this.roomId,
				laneId: this.laneId,
				sequence: this.sequence,
				kind,
				summary: redact(summary, this.input.repo),
				payload: payload ? redactObject(payload, this.input.repo) : undefined,
			}),
		);
		this.schedulePersist();
	}

	private async flush(): Promise<void> {
		if (this.persistenceError) throw this.persistenceError;
		if (!this.spool.length) return;
		await this.persistState();
		const response = await fetch(
			new URL(`/api/lanes/${encodeURIComponent(this.laneId)}/events`, this.input.server),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.token}`,
				},
				body: JSON.stringify({ events: this.spool }),
			},
		);
		const payload = (await response.json()) as { ackSequence?: number; error?: string };
		this.stopIfRevoked(response, payload.error);
		if (!response.ok) throw new Error(payload.error ?? `event flush failed (${response.status})`);
		this.spool = this.spool.filter((event) => event.sequence > (payload.ackSequence ?? 0));
		await this.persistState();
	}

	private async pollCommands(): Promise<void> {
		const url = new URL(
			`/api/lanes/${encodeURIComponent(this.laneId)}/commands`,
			this.input.server,
		);
		url.searchParams.set("after", String(this.commandSequence));
		const response = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
		const payload = (await response.json()) as { commands?: LaneCommand[]; error?: string };
		this.stopIfRevoked(response, payload.error);
		if (!response.ok) throw new Error(payload.error ?? `command poll failed (${response.status})`);
		for (const command of payload.commands ?? []) {
			this.commandSequence = Math.max(this.commandSequence, command.sequence);
			await this.persistState();
			await this.handleCommand(command);
		}
	}

	private async handleCommand(command: LaneCommand): Promise<void> {
		let result: LaneCommandResult = "accepted";
		let detail = "";
		try {
			if (command.expiresAt < Date.now()) result = "expired";
			else if (!policyAllows(this.input.policy, command.kind)) result = "rejected_policy";
			else if (!this.client) result = "failed";
			else {
				switch (command.kind) {
					case "suggest":
						process.stdout.write(`\n[multicodex conductor suggestion] ${command.text}\n`);
						break;
					case "request_status":
						this.emit("lane.status", `conductor requested status: ${command.text}`);
						break;
					case "start_followup":
						await this.client.startTurn(this.threadId, command.text);
						break;
					case "steer_active_turn":
						if (!this.activeTurnId) {
							result = "failed";
							detail = "no active turn";
						} else await this.client.steer(this.threadId, this.activeTurnId, command.text);
						break;
					case "request_interrupt":
						if (!this.activeTurnId) {
							result = "failed";
							detail = "no active turn";
						} else await this.client.interrupt(this.threadId, this.activeTurnId);
						break;
				}
			}
		} catch (cause) {
			result = "failed";
			detail = cause instanceof Error ? cause.message : String(cause);
		}
		this.emit("command.result", `${command.kind}: ${result}${detail ? ` (${detail})` : ""}`, {
			commandId: command.id,
			result,
		});
		await this.flush();
	}

	private stopIfRevoked(response: Response, detail?: string): void {
		if (response.status !== 410 || this.stopping) return;
		process.stderr.write(`\n[multicodex] ${detail || "lane removed by host"}\n`);
		this.stop();
	}

	private receiveNotification(notification: AppServerNotification): void {
		const params = notification.params;
		switch (notification.method) {
			case "thread/started": {
				if (this.waitingForTuiThread) this.captureTuiThread(object(params.thread));
				break;
			}
			case "turn/started": {
				this.flushActivity();
				const turn = object(params.turn);
				this.activeTurnId = text(turn.id);
				this.emit("turn.started", "Codex turn started", { turnId: this.activeTurnId });
				break;
			}
			case "turn/completed": {
				this.flushActivity();
				const turn = object(params.turn);
				const turnId = text(turn.id);
				this.emit("turn.completed", `Codex turn ${JSON.stringify(turn.status)}`, { turnId });
				if (turnId === this.activeTurnId) this.activeTurnId = null;
				break;
			}
			case "item/agentMessage/delta":
				this.activity.append("agent.message", params.delta);
				break;
			case "item/plan/delta":
				this.activity.append("agent.plan", params.delta);
				break;
			case "item/started":
				this.flushActivity();
				this.itemEvent("started", object(params.item));
				break;
			case "item/completed":
				this.flushActivity();
				this.itemEvent("completed", object(params.item));
				break;
			default:
				if (notification.method.includes("requestApproval")) {
					this.emit("approval.requested", "local Codex approval requested");
				}
		}
	}

	private flushActivity(): void {
		for (const activity of this.activity.drain()) {
			this.emit(activity.kind, activity.summary);
		}
	}

	private itemEvent(stage: "started" | "completed", item: Record<string, unknown>): void {
		const type = text(item.type) || "work";
		const summary = text(item.command) || text(item.path) || text(item.name) || type;
		if (/command/i.test(type)) {
			this.emit(stage === "started" ? "command.started" : "command.completed", summary, { type });
		} else if (/file/i.test(type)) this.emit("files.changed", summary, { type });
	}

	private async runTui(endpoint: string): Promise<void> {
		process.stdout.write(
			`\nMultiCodex lane ready\nroom: ${this.input.server}\nroom view: ${this.participantViewUrl()}\nthread: attaching from normal TUI\npolicy: ${this.input.policy}\n\n`,
		);
		const args = this.threadId
			? ["resume", "--remote", endpoint, "-C", this.input.repo, this.threadId]
			: ["--remote", endpoint, "-C", this.input.repo];
		if (this.input.prompt) args.push(this.input.prompt);
		const child = spawn(this.input.codexPath, args, {
			stdio: "inherit",
		});
		this.tuiChild = child;
		try {
			await waitForChild(child);
		} finally {
			this.tuiChild = null;
		}
	}

	private participantViewUrl(): string {
		const url = new URL(this.input.server);
		url.hash = new URLSearchParams({ lane: this.laneId, token: this.token }).toString();
		return url.toString();
	}

	private captureTuiThread(thread: Record<string, unknown>): void {
		if (!this.client || !this.waitingForTuiThread) return;
		const threadId = text(thread.id);
		const cwd = text(thread.cwd);
		if (!threadId || path.resolve(cwd) !== path.resolve(this.input.repo)) return;
		this.waitingForTuiThread = false;
		this.threadId = threadId;
		this.pendingTuiThreadId = threadId;
		this.emit("lane.status", "normal Codex TUI ready; bridge attaches on first turn", { threadId });
		void this.flush().catch(() => undefined);
	}

	private async attachPendingTuiThread(): Promise<void> {
		if (!this.client || !this.pendingTuiThreadId || this.attachingTuiThread) return;
		this.attachingTuiThread = true;
		try {
			await this.client.resumeThread(this.pendingTuiThreadId);
			this.emit("lane.thread_attached", "normal Codex TUI thread attached", {
				threadId: this.pendingTuiThreadId,
			});
			this.pendingTuiThreadId = null;
		} catch {
			// A fresh TUI thread has no rollout until its first turn. Retry without creating hidden work.
		} finally {
			this.attachingTuiThread = false;
		}
		await this.flush().catch(() => undefined);
	}

	private matches(state: PersistedBuilderState): boolean {
		return (
			normalizeServer(state.server) === this.input.server &&
			path.resolve(state.repo) === this.input.repo &&
			state.displayName === this.input.displayName
		);
	}

	private restore(state: PersistedBuilderState): void {
		this.roomId = state.roomId;
		this.laneId = state.laneId;
		this.token = state.token;
		this.sequence = state.sequence;
		this.commandSequence = state.commandSequence;
		this.threadId = state.threadId;
		this.spool = state.spool;
	}

	private reset(): void {
		this.roomId = "";
		this.laneId = "";
		this.token = "";
		this.sequence = 0;
		this.commandSequence = 0;
		this.threadId = "";
		this.spool = [];
	}

	private schedulePersist(): void {
		void this.persistState().catch((cause) => {
			this.persistenceError = cause instanceof Error ? cause : new Error(String(cause));
		});
	}

	private async persistState(): Promise<void> {
		if (!this.roomId || !this.laneId || !this.token) return;
		await this.stateStore.save({
			version: 1,
			server: this.input.server,
			roomId: this.roomId,
			laneId: this.laneId,
			token: this.token,
			displayName: this.input.displayName,
			repo: this.input.repo,
			policy: this.input.policy,
			sequence: this.sequence,
			commandSequence: this.commandSequence,
			threadId: this.threadId,
			spool: this.spool,
		});
	}
}

type ActivityEvent = {
	kind: "agent.message" | "agent.plan";
	summary: string;
};

export class ActivityDeltaBuffer {
	private readonly chunks = new Map<ActivityEvent["kind"], string[]>();

	append(kind: ActivityEvent["kind"], delta: unknown): void {
		const chunk = text(delta);
		if (!chunk) return;
		const chunks = this.chunks.get(kind) ?? [];
		chunks.push(chunk);
		this.chunks.set(kind, chunks);
	}

	drain(): ActivityEvent[] {
		const events: ActivityEvent[] = [];
		for (const [kind, chunks] of this.chunks) {
			const summary = chunks.join("").trim();
			if (summary) events.push({ kind, summary });
		}
		this.chunks.clear();
		return events;
	}
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function redact(value: string, repo: string): string {
	return value.replaceAll(path.resolve(repo), "<repo>").slice(0, 2_000);
}

function redactObject(value: Record<string, unknown>, repo: string): Record<string, unknown> {
	return JSON.parse(redact(JSON.stringify(value), repo)) as Record<string, unknown>;
}

async function waitForChild(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		child.once("exit", (code, signal) => {
			if (code === 0 || signal) resolve();
			else reject(new Error(`Codex TUI exited with ${code}`));
		});
		child.once("error", reject);
	});
}
