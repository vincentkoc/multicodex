import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
	type AlphaLane,
	type AlphaRoomSnapshot,
	type ConductorMessage,
	type LaneCommand,
	type LaneCommandKind,
	type LaneEvent,
	type LanePolicy,
	policyAllows,
	protocolVersion,
	requiredPolicyForCommand,
} from "../../protocol/src/index.ts";
import { localRoomHtml } from "./ui.ts";

type StoredLane = AlphaLane & { token: string };

type StoredRoom = Omit<AlphaRoomSnapshot, "lanes"> & {
	lanes: StoredLane[];
	commands: LaneCommand[];
	eventIds: string[];
};

export class LocalRoomStore {
	private readonly statePath: string;
	private readonly state: StoredRoom;
	private savePromise: Promise<void> = Promise.resolve();

	private constructor(statePath: string, state: StoredRoom) {
		this.statePath = statePath;
		this.state = state;
	}

	static async create(input: {
		stateDir: string;
		title: string;
		repo: string;
	}): Promise<LocalRoomStore> {
		await fs.mkdir(input.stateDir, { recursive: true, mode: 0o700 });
		const statePath = path.join(input.stateDir, "room.json");
		const state: StoredRoom = {
			version: protocolVersion,
			id: `room_${crypto.randomUUID()}`,
			title: input.title,
			repo: input.repo,
			createdAt: Date.now(),
			lanes: [],
			events: [],
			conductorMessages: [],
			commands: [],
			eventIds: [],
		};
		const store = new LocalRoomStore(statePath, state);
		await store.save();
		return store;
	}

	static async load(stateDir: string): Promise<LocalRoomStore> {
		const statePath = path.join(stateDir, "room.json");
		const state = JSON.parse(await fs.readFile(statePath, "utf8")) as StoredRoom;
		return new LocalRoomStore(statePath, state);
	}

	snapshot(): AlphaRoomSnapshot {
		return {
			version: this.state.version,
			id: this.state.id,
			title: this.state.title,
			repo: publicRepoName(this.state.repo),
			createdAt: this.state.createdAt,
			lanes: this.state.lanes.map(({ token: _token, ...lane }) => ({
				...lane,
				repo: publicRepoName(lane.repo),
			})),
			events: this.state.events.slice(-300),
			conductorMessages: this.state.conductorMessages.slice(-100),
		};
	}

	async join(input: {
		displayName: string;
		repo: string;
		policy: LanePolicy;
	}): Promise<{ lane: AlphaLane; token: string }> {
		const now = Date.now();
		const lane: StoredLane = {
			id: `lane_${crypto.randomUUID()}`,
			token: crypto.randomUUID(),
			displayName: input.displayName,
			repo: input.repo,
			policy: input.policy,
			connected: false,
			threadId: null,
			currentTurnId: null,
			lastEventSequence: 0,
			lastCommandSequence: 0,
			status: "joining",
			joinedAt: now,
			updatedAt: now,
		};
		this.state.lanes.push(lane);
		await this.save();
		const { token, ...publicLane } = lane;
		return { lane: publicLane, token };
	}

	async resumeLane(
		laneId: string,
		token: string,
		input: {
			displayName: string;
			repo: string;
			policy: LanePolicy;
		},
	): Promise<{ lane: AlphaLane }> {
		const lane = this.authorizeLane(laneId, token);
		if (!lane) throw new RoomError(401, "valid lane capability required");
		lane.displayName = input.displayName;
		lane.repo = input.repo;
		lane.policy = input.policy;
		lane.updatedAt = Date.now();
		lane.status = "reconnecting";
		await this.save();
		const { token: _token, ...publicLane } = lane;
		return { lane: publicLane };
	}

	authorizeLane(laneId: string, token: string): StoredLane | null {
		return this.state.lanes.find((lane) => lane.id === laneId && lane.token === token) ?? null;
	}

	async appendEvents(laneId: string, token: string, events: LaneEvent[]): Promise<number> {
		const lane = this.authorizeLane(laneId, token);
		if (!lane) throw new RoomError(401, "valid lane capability required");
		for (const event of events) {
			if (
				event.version !== protocolVersion ||
				event.roomId !== this.state.id ||
				event.laneId !== lane.id
			) {
				throw new RoomError(400, "invalid lane event envelope");
			}
			if (this.state.eventIds.includes(event.id) || event.sequence <= lane.lastEventSequence)
				continue;
			if (event.sequence !== lane.lastEventSequence + 1) {
				throw new RoomError(409, `event gap: expected ${lane.lastEventSequence + 1}`);
			}
			this.state.events.push(event);
			this.state.eventIds.push(event.id);
			lane.lastEventSequence = event.sequence;
			lane.updatedAt = event.at;
			applyLaneEvent(lane, event);
		}
		this.state.events.splice(0, Math.max(0, this.state.events.length - 1_000));
		this.state.eventIds.splice(0, Math.max(0, this.state.eventIds.length - 2_000));
		await this.save();
		return lane.lastEventSequence;
	}

	commandsAfter(laneId: string, token: string, after: number): LaneCommand[] {
		const lane = this.authorizeLane(laneId, token);
		if (!lane) throw new RoomError(401, "valid lane capability required");
		return this.state.commands.filter(
			(command) => command.laneId === laneId && command.sequence > after,
		);
	}

	async queueCommand(laneId: string, kind: LaneCommandKind, text: string): Promise<LaneCommand> {
		const lane = this.state.lanes.find((candidate) => candidate.id === laneId);
		if (!lane) throw new RoomError(404, "lane not found");
		if (!policyAllows(lane.policy, kind)) {
			throw new RoomError(409, `${kind} requires ${requiredPolicyForCommand(kind)} policy`);
		}
		const now = Date.now();
		const command: LaneCommand = {
			version: protocolVersion,
			id: `command_${crypto.randomUUID()}`,
			roomId: this.state.id,
			laneId,
			sequence: lane.lastCommandSequence + 1,
			at: now,
			expiresAt: now + 5 * 60_000,
			kind,
			text,
			source: "conductor",
			requiredPolicy: requiredPolicyForCommand(kind),
		};
		lane.lastCommandSequence = command.sequence;
		lane.updatedAt = now;
		this.state.commands.push(command);
		this.state.commands.splice(0, Math.max(0, this.state.commands.length - 500));
		await this.addConductorMessage(
			"conductor",
			`${kind.replaceAll("_", " ")} -> ${lane.displayName}: ${text}`,
		);
		return command;
	}

	async addConductorMessage(author: ConductorMessage["author"], body: string): Promise<void> {
		this.state.conductorMessages.push({
			id: `message_${crypto.randomUUID()}`,
			author,
			body,
			at: Date.now(),
		});
		this.state.conductorMessages.splice(0, Math.max(0, this.state.conductorMessages.length - 300));
		await this.save();
	}

	private async save(): Promise<void> {
		this.savePromise = this.savePromise.then(async () => {
			const temporary = `${this.statePath}.tmp`;
			await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(temporary, this.statePath);
		});
		await this.savePromise;
	}
}

export type LocalRoomHandlers = {
	onConductorMessage: (text: string) => Promise<void>;
	onConductorSteer: (laneId: string, text: string) => Promise<void>;
};

export async function startLocalRoomServer(input: {
	store: LocalRoomStore;
	port: number;
	handlers: LocalRoomHandlers;
}): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((request, response) => {
		void handleRequest(input.store, input.handlers, request, response).catch((cause) => {
			const error = cause instanceof RoomError ? cause : new RoomError(500, errorMessage(cause));
			sendJson(response, error.status, { error: error.message });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(input.port, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : input.port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((cause) => (cause ? reject(cause) : resolve())),
			);
		},
	};
}

async function handleRequest(
	store: LocalRoomStore,
	handlers: LocalRoomHandlers,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (request.method === "GET" && url.pathname === "/") {
		sendText(response, 200, localRoomHtml(), "text/html; charset=utf-8");
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/snapshot") {
		sendJson(response, 200, store.snapshot());
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/join") {
		const body = await readJson(request);
		const policy = body.policy;
		if (!["observe", "suggest", "steer"].includes(String(policy))) {
			throw new RoomError(400, "policy must be observe, suggest, or steer");
		}
		const joined = await store.join({
			displayName: requiredString(body.displayName, "displayName"),
			repo: requiredString(body.repo, "repo"),
			policy: policy as LanePolicy,
		});
		sendJson(response, 201, { room: store.snapshot(), ...joined });
		return;
	}
	const resumeMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/resume$/);
	if (request.method === "POST" && resumeMatch) {
		const body = await readJson(request);
		const policy = body.policy;
		if (!["observe", "suggest", "steer"].includes(String(policy))) {
			throw new RoomError(400, "policy must be observe, suggest, or steer");
		}
		const resumed = await store.resumeLane(decodeURIComponent(resumeMatch[1]!), bearer(request), {
			displayName: requiredString(body.displayName, "displayName"),
			repo: requiredString(body.repo, "repo"),
			policy: policy as LanePolicy,
		});
		sendJson(response, 200, { room: store.snapshot(), ...resumed });
		return;
	}
	const eventMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/events$/);
	if (request.method === "POST" && eventMatch) {
		const laneId = decodeURIComponent(eventMatch[1]!);
		const body = await readJson(request);
		const events = Array.isArray(body.events) ? (body.events as LaneEvent[]) : [];
		const ackSequence = await store.appendEvents(laneId, bearer(request), events);
		sendJson(response, 200, { ackSequence });
		return;
	}
	const commandMatch = url.pathname.match(/^\/api\/lanes\/([^/]+)\/commands$/);
	if (request.method === "GET" && commandMatch) {
		const laneId = decodeURIComponent(commandMatch[1]!);
		const after = Number(url.searchParams.get("after") ?? "0");
		sendJson(response, 200, { commands: store.commandsAfter(laneId, bearer(request), after) });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/conductor/message") {
		const body = await readJson(request);
		const text = requiredString(body.text, "text");
		await store.addConductorMessage("host", text);
		void handlers
			.onConductorMessage(text)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/conductor/steer") {
		const body = await readJson(request);
		const laneId = requiredString(body.laneId, "laneId");
		const text = requiredString(body.text, "text");
		await store.addConductorMessage("host", `requested steer -> ${laneId}: ${text}`);
		void handlers
			.onConductorSteer(laneId, text)
			.catch((cause) =>
				store.addConductorMessage("system", `conductor steer failed: ${errorMessage(cause)}`),
			);
		sendJson(response, 202, { accepted: true });
		return;
	}
	throw new RoomError(404, "not found");
}

function applyLaneEvent(lane: StoredLane, event: LaneEvent): void {
	lane.status = event.summary;
	if (event.kind === "lane.connected") lane.connected = true;
	if (event.kind === "lane.disconnected") lane.connected = false;
	if (event.kind === "lane.thread_attached") lane.threadId = stringPayload(event, "threadId");
	if (event.kind === "turn.started") lane.currentTurnId = stringPayload(event, "turnId");
	if (["turn.completed", "turn.failed"].includes(event.kind)) lane.currentTurnId = null;
}

function stringPayload(event: LaneEvent, key: string): string | null {
	const value = event.payload?.[key];
	return typeof value === "string" ? value : null;
}

function publicRepoName(repo: string): string {
	return path.basename(path.resolve(repo)) || "<repo>";
}

class RoomError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > 256_000) throw new RoomError(413, "request too large");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
	} catch {
		throw new RoomError(400, "valid JSON required");
	}
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new RoomError(400, `${name} is required`);
	return value.trim();
}

function bearer(request: IncomingMessage): string {
	const value = request.headers.authorization;
	if (!value?.startsWith("Bearer ")) throw new RoomError(401, "lane capability required");
	return value.slice("Bearer ".length);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	sendText(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function sendText(
	response: ServerResponse,
	status: number,
	body: string,
	contentType: string,
): void {
	response.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
